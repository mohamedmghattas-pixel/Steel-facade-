# Assemblies and 3D ↔ drawing navigation

This document covers how FacadeSteel groups parts into assemblies, how you
group them by hand, how you select whole assemblies in the 3D view, and how you
move between a part in 3D and its drawings (both ways).

| Part | File |
| --- | --- |
| Data model (`Project.assemblyGroups`) | `src/core/model/types.ts`, defaults in `ops.ts`, migration in `src/state/storage.ts` |
| Derivation (automatic and manual assemblies, shop joints) | `src/core/derive/model.ts` (`manualGroups`, `groupPieces`, `assemblyByPart`) |
| Operations (pure, tested) | `src/core/model/assemblies.ts` |
| Drawing index and navigation tags | `src/core/drawings/navigation.ts`, `EntTag.nav` in `src/core/drawings/types.ts` |
| User commands | `src/ui/navigationActions.ts` |
| UI: selection mode, context menu section, Properties, Assemblies list, Show in 3D | `src/ui/AssemblyPanels.tsx`, `src/ui/assemblies.css` |
| Drawing preview (click targets, highlight) | `src/ui/DrawingEditor.tsx` |
| Viewer (assembly highlight, isolation, zoom to parts) | `src/viewer/Viewer.ts` |
| Assistant tools | `src/assistant/modules/assemblies.ts` |
| Tests | `tests/assemblies.test.ts`, `tests/navigation.test.ts` |

## 1. Automatic and manual assemblies

**Automatic (the default).** Every part shop-welded to another is in the same
assembly: plates and cleats welded to a member, members joined by a *Welded
joint*, a bracket's plates welded together. Derivation unions parts over the
shop welds (`weldedTo` and connection `welds`), see
[CONNECTION_GEOMETRY.md §8](CONNECTION_GEOMETRY.md). Bolted parts stay separate
assemblies: a transom on angle cleats is three assemblies (the transom and two
loose cleats). Nothing changes for projects that never group by hand. A member carrying a
profile assembly (composite section) is one assembly of its component parts, the
main component its main part ([PROFILE_ASSEMBLIES.md](PROFILE_ASSEMBLIES.md)).

**Manual.** You can also group members, free plates and connections into one
shipping assembly (a ladder of a mullion with its transoms, a pre-assembled
bracket on its mullion …). The group is stored in `Project.assemblyGroups`:

```ts
interface AssemblyGroup {
  id: Id;               // "ag…"
  name?: string;
  members: Id[];        // members with a profile
  plates: Id[];         // free plates (Project.plates)
  connections?: Id[];   // connections whose parts join as a whole (e.g. a bracket)
  main?: Id;            // a member or plate of the group
  prefix?: string;      // mark prefix
}
```

A member or plate belongs to at most one group. New fields are defaulted in
`createProject` and `migrateProject` (older files load with no groups).

### Derivation

1. Shop welds are unioned as before.
2. Each group's members, plates and connection parts are unioned into one
   assembly, so everything welded to them comes along.
3. **Joints between grouped members** (the connection's main member and every
   secondary member in the same group) are *shop joints* of the assembly
   (`Assembly.joints`):
   - a joint without bolts (e.g. *Welded joint*) is a `'weld'` joint (such
     members are one assembly anyway);
   - a bolted joint (angle cleat, fin plate, end plate …) **stays bolted**:
     its loose parts (cleats) join the assembly, and its bolts are **shop
     bolts** (`BoltItem.shop`), fitted before delivery. This is the decision
     for "grouped members across a bolted joint": one shipping assembly with
     its bolted joints made in the shop. The connection, its holes and its
     bolts are unchanged; only where it is assembled changes.
   - Joints to members outside the group stay site joints (a transom's cleat
     at its other mullion stays a loose CL assembly).
   - Connections without a main member (slab brackets, base plates) are never
     shop joints; add them to the group explicitly to pre-assemble them.
4. **Main part:** the group's `main` when it is in the assembly, else members
   before profiles before plates, then the heaviest (a bracket's
   `assemblyMain` back plate does not win inside a manual assembly).
5. **Prefix:** the group's `prefix`, else the main member's role prefix
   (Project settings → Assembly prefixes).
6. **Warnings** (Checks tab): parts of a group that do not touch
   (`groupPieces`: shared node, a member end on the other's axis within 1 mm, a
   connection between them, a plate welded to a member or within its section
   depth) — *"Manual assembly M5: its parts do not touch — 2 separate pieces"*;
   two groups welded together (they form one assembly).

### Numbering and mark locks

- The signature of a manual assembly is the usual one (main part mark plus the
  marks and placements of the other parts), so it includes the grouped
  composition; identical manual assemblies share a mark.
- Manual assemblies are numbered **after the automatic ones of their prefix**,
  so grouping parts does not renumber other assemblies (unless a mark loses its
  last instance). A new ladder of mullion M2 becomes M5 when M1–M4 exist.
- **Locks** work as for every assembly ([MODEL_MANAGEMENT.md §1](MODEL_MANAGEMENT.md)):
  grouping a locked assembly changes its signature, so it gets a new mark,
  `lock: 'changed'`, the old mark in `lockedMark` and a warning; locked marks
  stay reserved; untouched assemblies keep their locked marks. Re-lock to accept.
- `Member.markOverride` (manual mark) applies to the manual assembly through
  its main member (or the first member with one).

### Keeping groups consistent

| Operation | Group |
| --- | --- |
| Delete a member / plate / connection (any operation, including join and trim) | it leaves its group; an empty group is removed (`pruneAssemblyGroups`, run by `deleteMembers`, `deletePlates`, `deleteConnections` and after every `store.apply`) |
| Split / break | both pieces stay in the group (`splitMember`) |
| Copy (Copy tool, array) | a group whose members and welded plates are all copied becomes a new group of the copies; partly copied groups are not carried over |
| Undo / redo | snapshots, as for every edit |

### Operations (`src/core/model/assemblies.ts`)

All mutate a project draft (run them in `store.apply`, one undo step each) and
throw `AssemblyError` with a message when they cannot run:

| Function | Does |
| --- | --- |
| `createAssembly(p, memberIds, plateIds, { name, main, prefix, connections })` | new group; the items leave other groups |
| `addToAssembly(p, groupId, members, plates, connections)` | add (items leave other groups) |
| `removeFromAssembly(p, members, plates, connections)` | remove from whatever group; empty groups go |
| `explodeAssembly(p, groupId)` | remove the group (back to automatic) |
| `setAssemblyMain(p, groupId, id)` | main part (a member or plate; added to the group if needed) |
| `setAssemblyPrefix(p, groupId, prefix \| null)`, `renameAssembly` | prefix (1–8 letters, digits, - or _) and name |
| `groupForAssembly(p, dm, assembly)` | the group of a derived assembly; an automatic one becomes manual first (its members and plates, same main) |
| `assemblyOf(p, dm, memberId)`, `assemblyOfRef`, `assemblyByMain`, `assembliesOf` | queries |
| `assemblySelection(dm, assemblies)` | the selection standing for whole assemblies (below) |
| `validateAssembly(p, members, plates, connections)` | pieces + warnings before grouping |

## 2. Selecting assemblies in the viewer

- **Part / Assembly mode** — the toggle in the viewport toolbar, or key **A**.
  - *Part*: a click selects the part (member, plate or connection).
  - *Assembly*: a click selects **every part of the clicked part's assembly**;
    Shift+click adds or removes whole assemblies; a box selection selects every
    assembly it touches. Switching to Assembly mode widens the current selection
    to its assemblies.
  - In Part mode, **Alt+click** selects the assembly.
- **Highlight.** Parts of selected assemblies are drawn pink, the main part
  darker pink — distinct from the yellow part selection.
- **Isolate** — the toolbar button or key **I** (toggle): only the assemblies of
  the selection are drawn (with their bolts) and can be picked; everything else
  is hidden until you press it again. The isolated set follows the model
  (parts added to the assembly appear).
- **Selection model.** The store keeps selecting members, plates and
  connections, so every existing command works on the selection. Whole
  assemblies add `selection.assemblies`: their main part refs. With it, the
  selection holds the assemblies' members and plates and the connections whose
  parts all belong to them (a cleat bolted to the next member stays out; its
  parts inside the assembly are still highlighted). Edits prune both.

## 3. Grouping by hand

Where:
- **Right-click** a part in 3D → the *Assembly* section of the menu (at the top
  of the member menu; plates and connection parts get it on their own).
- **Properties → Assembly** (members, plates, connections).
- **Outputs → Assemblies** (toolbar and right-click on a row).
- The assistant.

| Command | Does |
| --- | --- |
| Create assembly from the selection | the selected members and plates form a new manual assembly; the part right-clicked (else the first member) is its main part. Connections join only when nothing else is selected (e.g. a bracket), so a box selection does not drag in every bracket. Warns when the parts do not touch. |
| Add the selection to M3 | the other selected members / plates join the assembly of the part right-clicked (an automatic assembly becomes manual) |
| Remove from M3 | the selected members / plates leave their manual assembly |
| Explode M3 | the manual assembly is removed; its parts go back to automatic grouping |
| Set as main part of M3 | the part right-clicked becomes the main part |
| Name, Prefix (Properties; *Prefix…*, *Rename…* in the list) | manual assemblies only; automatic ones take the role prefix |

**Assemblies list** (Outputs → *Assemblies*): mark, quantity, main part, kg
each / total, phase, delivery batch, kind (auto / manual / mixed), lock state,
name; search (mark, profile, name, phase, batch) and *All / Manual /
Automatic*. Click a row: select every instance and zoom to them. Double-click:
open its assembly drawing. Right-click: the actions above for that row.

## 4. From 3D to the drawings

Right-click a member, plate or connection part (or use Properties → Assembly):

| Command | Opens |
| --- | --- |
| Open part drawing (pl3) | the part drawing of its mark (`…-P-pl3`) |
| Open assembly drawing (M3) | its assembly drawing (`…-A-M3`), its balloon and parts-list row highlighted |
| Show on GA sheet | the GA sheet — or the **zone sheet** of a divided view — that shows its assembly, zoomed to its mark, highlighted |
| Show on erection sheet | the erection sequence (or setting-out) sheet that shows it |
| Sheets showing M3… (Properties) | every GA / zone / erection / section sheet that shows the assembly |

The drawing opens in **Outputs → Drawings** under the 3D view; the 3D view stays
visible. The preview zooms to the highlighted mark and scrolls it to the middle.

**Index** (`src/core/drawings/navigation.ts`, pure): from the drawing index (the
register, made without drawing the sheets — see *Drawings on demand* in
[DRAWING_STANDARDS.md](DRAWING_STANDARDS.md)) and the derived model. Part and
assembly drawings come straight from the register. For an assembly instance,
`instanceSheets` makes only the view sheets that can show it (each plan item
knows, without drawing, the best score it can give an instance — its zone, its
phase, its brackets) and, for *Show on GA sheet*, only as many as needed to know
the best one; made sheets stay in the drawing cache, so the Drawings tab and
navigation share them. `buildDrawingIndex` builds the same index from a drawn set
(`allDrawings`).
- part mark → part drawing; assembly mark → assembly drawing;
- assembly instance (main part ref) → the sheets that show it, best first:
  its mark is placed on the sheet (3) › it is listed in the sheet's zone (2) ›
  its parts are only drawn (1); then GA › erection sequence › setting-out ›
  section. On a divided facade the zone sheet comes before the overall GA,
  which shows every part but no marks. The box of the mark is kept for the
  highlight.

## 5. From the drawings to 3D

In **Outputs → Drawings**:
- **Show in 3D** (toolbar of the preview) selects what the sheet stands for and
  zooms to it — the drawing stays open:
  - part sheet: every part of its mark;
  - assembly sheet: every assembly of its mark;
  - GA / zone / erection / section sheet: the assemblies marked on it (a zone
    sheet: its zone's assemblies; an overall sheet of a divided view:
    everything drawn).
  - **‹ 1 of N ›** steps through the instances one at a time (by position along
    the facade), selecting and zooming to each.
- **Click** in the preview (Select tool) on
  - a GA / zone / erection mark → that assembly instance;
  - a part outline on a GA / zone / erection view → that part (its assembly in
    Assembly mode);
  - a balloon or parts-list row → every part of that mark (within assemblies of
    the sheet's mark);
  - an assembly list row (GA schedule, zone and phase lists, "Used in") →
    every assembly of that mark.
  The selection is shown in 3D and the view zooms to it; what was clicked stays
  highlighted on the sheet.
- **Double-click** a mark on a GA / erection / section sheet → its assembly
  drawing; a balloon or row on an assembly sheet → the part drawing; a "Used
  in" row on a part sheet → that assembly drawing; a drawing-register row or a
  zone outline / zone index row → that sheet.

**Navigation tags.** Drawing entities carry `nav` tags next to `id` / `group`
(`EntTag.nav`: `asm`, `part`, `inst` = assembly main part ref, `ref` = part
ref, `sheet` = drawing id): GA, zone and erection marks (from `placeMarks`),
part outlines on GA / zone / erection views, balloons of assembly sheets,
section and detail balloons, bracket balloons of setting-out plans, and rows of
tables that name a mark (`TableSpec.nav`). They are **data only**: the
fingerprint hashes geometry and text, not tags, so every existing sheet keeps its
fingerprint (tested against `tests/fixtures/sample-drawing-fingerprints.json`)
and SVG / PDF / DXF output is unchanged. The preview draws invisible hit boxes
(`.dwg-nav rect` with `data-nav-*` attributes) over marks, balloons and rows;
outlines are picked by distance.

## 6. Drawings of manual assemblies

- The assembly drawing shows every part of the manual assembly in the main
  part's axes, with balloons and the parts list (a ladder lists the mullion
  and its two transoms, and the cleats of its shop joints).
- A **Shop bolts (joints inside the assembly)** table lists the shop bolts.
- The GA's **Site bolts and anchors** schedule leaves shop bolts out.
- The name of a manual assembly is added to its drawing's subtitle.
- Without manual assemblies every drawing is exactly as before.

## 7. Assistant

`src/assistant/modules/assemblies.ts`:

| Tool | Does |
| --- | --- |
| `assembly_list` | assemblies with qty, main part, kg, kind, group id, members, shop joints, lock; filter by kind or mark |
| `assembly_create` | group members / plates / connections (or the selection); name, main, prefix |
| `assembly_add` / `assembly_remove` | add to an assembly (id, mark or member id; automatic ones become manual) / take out of manual assemblies |
| `assembly_explode` | remove the manual assembly (every manual instance of a mark) |
| `assembly_set_main` | main part, prefix and name |
| `open_drawing_for` | open the part / assembly drawing or the GA / erection sheet of a member or mark; lists the sheets showing it |
| `show_in_3d` | select and zoom to a mark or what a drawing shows; `instance` picks one of N |

Every edit is one undo step.

## Limits

- **Sub-assemblies** (Tekla's *add as sub-assembly*) are not modelled: a
  manual assembly is flat. Nested shipping units are not represented.
- **Copies by Rotate / Mirror / Offset with copy** (modify tools) are not
  grouped; group the copies again. The Copy tool and arrays copy whole groups.
- **Wireframe check** re-pieces lines; new pieces it creates (other than by
  splitting) are not added to the groups of the originals.
- Bolted shop joints are flagged, but the assembly drawing does not draw the
  bolts or dimension the joint; the shop bolt list gives sizes and counts.
- The assembly drawing of a large manual assembly (long transoms across the
  main part's axes) uses the linear assembly layout; views can get small.
- Isolation hides the wireframe and labels; reference models stay visible.
- The 3D → drawing commands make the sheets they need (the best GA / zone sheet:
  usually one); *Sheets showing M3…* makes every view sheet that can show it —
  on very large models the GA overall and zone sheets take about a second each.
- Alt+click may be taken by the window manager on some Linux desktops; use
  Assembly mode instead.
