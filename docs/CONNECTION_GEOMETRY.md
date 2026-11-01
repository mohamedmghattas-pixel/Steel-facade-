# Connection geometry: how members and connection parts are positioned

Reference for developers and detailing-software specialists who verify or
extend the placement code. Every statement cites the code as `path:line`
(repository-relative). Values in §12 are printed by `deriveModel` on a real
model. Where the code makes a choice a reader could trip over, a **Notes /
caveats** line says so. §14 lists the inconsistencies the first version of
this document found and how each was fixed.

Notation: `N` = node position, `â` = unit vector, `·` = dot product, `×` =
cross product, `madd(p, d, s) = p + d·s` (`src/core/model/geometry.ts:22`).

---

## 1. Conventions

| Item | Value | Source |
| --- | --- | --- |
| Units | millimetres, degrees | `src/core/model/types.ts:5` |
| World axes | X east, Y north, Z up | `src/core/model/types.ts:5` |
| Handedness | Every frame is right-handed: `z = x × y` (members, plates), or equivalently `x = y × z` (angles, tees) | `src/core/model/geometry.ts:84`, `src/core/connections/common.ts:166`, `src/core/connections/kit.ts:338,374` |
| Angles | degrees in the data (`rotation`, saw angles, `Hole2D.angle`), radians only inside functions | `src/core/model/types.ts:66`, `src/core/model/geometry.ts:87`, `src/core/geometry/endPrep.ts:47` |
| `EPS` | 1e-6 (zero-length normalise, parallel tests) | `src/core/model/geometry.ts:3,19` |
| `NODE_TOL` | 0.5 mm: node merge, "member passes through node" | `src/core/model/ops.ts:60,169-172,419` |
| Point equality / segment intersection | 0.5 mm | `src/core/model/geometry.ts:23,340` |
| Shortest line | lines shorter than 1 mm are not created | `src/core/model/ops.ts:204` |
| End on node (mitre/fit) | 1 mm | `src/core/geometry/endPrep.ts:138-139` |
| Vertical / horizontal (local axes **and** rules) | `\|d̂·Ẑ\| > 0.995` (`VERTICAL_COS`, about 5.7° from plumb) / `< 0.005` (`HORIZONTAL_SIN`): `isVerticalAxis` / `isHorizontalAxis` | `src/core/model/geometry.ts:41-54,81`, `src/core/model/ops.ts:428-431` |
| Collinear (rules) | `\|û·v̂\| > 0.999` | `src/core/connections/registry.ts:229` |
| Through member at node | distance < `NODE_TOL` and `1e-4 < t < 1−1e-4` | `src/core/model/ops.ts:418-419` |
| Cut angle limit / saw warning | 85° / 60° | `src/core/geometry/endPrep.ts:51,53` |

Section coordinates: a profile outline's `x` is member local `y` (width `b`),
its `y` is local `z` (height `h`); outlines are centred on their bounding box
(`src/core/library/shapes.ts:4-7`). `Profile.h` / `Profile.b` are the
bounding-box height and width (`src/core/library/profiles.ts:36-38,77-78`,
`src/core/library/shapes.ts:134-146`). Example: `RHS 100x50x4` has `h = 100`,
`b = 50` (`src/core/library/profiles.ts:135-136`).

**Notes:** one predicate decides verticality for the member local axes
(`axesFor`), the placement rules (`memberDirection` → `autoConnect`,
`endsFor`, auto-assign rules) and IFC role guessing
(`src/core/io/ifcImport.ts:521`). A member the rules treat as a mullion
therefore also gets mullion local axes (§3.1). The `|·| > 0.7` tests in the
movement code (`src/core/movement/provisions.ts:67,521,552`,
`src/core/movement/report.ts:162`) are a different test: they classify a
direction by its dominant facade direction (vertical against along / out),
not whether a member is vertical.

---

## 2. Frames and transforms

```ts
interface Frame { origin: Vec3; x: Vec3; y: Vec3; z: Vec3 }   // src/core/model/geometry.ts:27-32
```

- `toWorld(f, lx, ly, lz) = f.origin + f.x·lx + f.y·ly + f.z·lz` (`src/core/model/geometry.ts:133-135`)
- `toLocal(f, p) = ((p−o)·f.x, (p−o)·f.y, (p−o)·f.z)` (`src/core/model/geometry.ts:138-141`).
  This is exact only for orthonormal frames. Every frame the code builds is
  orthonormal: member axes (§3.1), plate frames (`plateOn` orthogonalises,
  §2.1), free plates (§2.2), angles, tees and section parts
  (`src/core/connections/kit.ts:335-341,371-389`).
- Rodrigues rotation `rotateAbout` (`src/core/model/geometry.ts:123-130`).

### 2.1 Plate frames: `plateOn`

Every connection plate is placed with
`plateOn(P, n_out, X, Y, t)` (`src/core/connections/common.ts:162-169`):

```
x = X̂,  y = norm(Y − x·(x·Y)),  z = x × y      (Gram–Schmidt: y keeps its side of x)
throws "plate axes are zero or parallel" when |x| or |y| vanishes
origin = P              if z·n_out ≥ 0
origin = P + n̂_out·t    otherwise
```

The plate occupies frame `z ∈ [0, t]` (`src/core/connections/common.ts:52`).
A 2-D outline vertex `(u, v)` at depth `s ∈ [0, t]` is
`toWorld(frame, u, v, s)`. `P` is the **contact point**: it lies in the
contact plane and maps to outline `(0, 0)`. The material always lies on the
`n_out` side of the contact plane. The contact face is at frame `z = 0` when
`z·n_out ≥ 0`, and at `z = t` otherwise. The kit wrapper `addPlate` takes the
same arguments (`src/core/connections/kit.ts:184-189`).

```
   frame.y
     ^
     |  (0,H) +--------------------------+ (L,H)      outline: rect(L,H) = (0,0),(L,0),(L,H),(0,H)
     |        |                          |                     src/core/connections/common.ts:146-153
     |        |    o  hole (x, y, d)     |
     |        |   (=slot: centres at     |            thickness: along frame.z, z ∈ [0, t]
     |        |    ±slot/2 along angle)  |            (out of the page)
     |  (0,0) +--------------------------+ (L,0)
     +----------------------------------------> frame.x
   origin (= P, or P + n_out·t when x × y points away from n_out)
```

**Notes:** the in-plane axes are orthonormalised (`src/core/connections/common.ts:163-165`):
callers that pass perpendicular axes (all built-in ones) get exactly the
previous frame; a skewed `Y` is replaced by its component perpendicular to
`X`, so the outline is laid out in an orthonormal frame and `toLocal` is
exact. A degenerate pair throws; inside `build` the exception becomes a
connection warning (`src/core/derive/model.ts:288-292`), in a custom template
a warning for that plate (`src/core/connections/custom.ts:108-112`). Free
plates are orthogonalised the same way (`src/core/derive/model.ts:505-507`).

### 2.2 Free plates (`Project.plates`)

`frame = { origin, x: x̂A, z: norm(x̂A × yAxis), y: z × x }`
(`src/core/derive/model.ts:505-507`). The outline is the flat pattern in
plate x/y, counter-clockwise, and the plate occupies `z ∈ [0, t]`
(`src/core/model/types.ts:311-316`). `weldedTo: <memberId>` joins the member's
assembly only when that member has a profile; otherwise a warning is raised
(`src/core/derive/model.ts:511-512,532`).

### 2.3 Work planes

`planeAxes` (`src/core/model/geometry.ts:191-207`) gives:

- XY: `u = X`, `v = Y`, `n = Z`
- XZ: `u = X`, `v = Z`, `n = −Y`
- YZ: `u = Y`, `v = Z`, `n = X`
- custom: `u = x̂A`, `n = norm(u × yA)`, `v = n × u`, origin shifted by `offset` along `n`.

`planeToWorld` and `worldToPlane` are at `src/core/model/geometry.ts:283-292`.
For the XZ plane, `n = u × v = −Y`.

---

## 3. Member geometry

A `Member` runs between two nodes: `start` → `end`
(`src/core/model/types.ts:59-90`). The **wire line** is `a = node(start)` →
`b = node(end)`. The **section centre line** is the wire line shifted by the
alignment. The **physical axis** is the centre line between the extended,
trimmed or cut ends.

### 3.1 Local axes (`axesFor` / `memberAxes`, `src/core/model/geometry.ts:72-121`)

Every consumer gets a member's axes through `memberAxes(a, b, m)` =
`axesFor(a, b, m.rotation, m.normal)`: `memberGeom`
(`src/core/derive/memberGeom.ts:50`, so meshes, IFC, DSTV, drawings, clash
solids and connections), the end-preparation centre lines
(`src/core/geometry/endPrep.ts:124`) and Auto-connect's cleat side
(`src/core/connections/registry.ts:208`).

```
x̂  = norm(b − a)
with a surface normal n (Member.normal, src/core/model/types.ts:82), unless |n̂·x̂| > 0.999 or n = 0:
   ẑ0 = norm(n − (n·x̂)x̂),   ŷ0 = ẑ0 × x̂          (depthFromNormal, geometry.ts:106)
otherwise (no normal, the rule of every earlier model):
   vertical = isVerticalAxis(x̂)  ⇔  |x̂_z| > 0.995       (the rules' test, §1)
   r  = vertical ? Ŷ : Ẑ
   ŷ0 = norm(r × x̂),   ẑ0 = x̂ × ŷ0
θ  = rotation (deg):  ŷ = ŷ0 cosθ + ẑ0 sinθ,   ẑ = ẑ0 cosθ − ŷ0 sinθ   (right-handed about x̂, both cases)
```

**Surface normal.** `Member.normal` makes the section perpendicular to the
facade: the depth (local z) is the surface normal projected perpendicular to
the member, the width (local y) lies in the surface, and `ẑ0 = x̂ × ŷ0` keeps the
frame right-handed as before. The normal points to the exterior side; it does
not depend on the direction the line was drawn (a member drawn the other way
gets the same ẑ and the opposite ŷ, as without a normal). It is set by *Orient
profiles to surface* and the wireframe check ([WIREFRAME_CHECK.md §5a](WIREFRAME_CHECK.md)).
Members without a normal derive exactly as before (a test compares 400 random
members bit for bit). Copy and split carry the normal; mirror reflects it and
negates the rotation, so the mirrored depth is the mirror image of the
original's (`mirrorMembers`, `src/core/model/ops.ts`). The wireframe
fingerprint includes the normal and rotation of oriented members only.

- Non-vertical: `ŷ0 = (−x̂y, x̂x, 0)/|…|` is horizontal and points to the left
  of the travel direction seen from above. `ẑ0` has a positive Z component:
  the section's "up".
- Vertical (plumb or leaning less than about 5.7°): `ẑ0 = norm(x̂ × (Ŷ × x̂))`,
  the projection of `+Y` onto the section plane — exactly `+Y` for a plumb
  member, and still about `+Y` for a near-plumb one, so the section does not
  turn when a mullion leans slightly (variant "tilt", §12.4). `ŷ0 = +X` for a
  member drawn upwards and `−X` for one drawn downwards (variant "down").
  This is the same rule as for horizontal members: `ŷ` flips with `x̂` (it is
  "to the left of the travel direction"), the section depth `ẑ` does not, so
  a symmetric section sits the same way whichever way the line was drawn and
  an asymmetric one (L, U, C, Z, T) is mirrored across `ẑ`. Kept on purpose:
  changing it would move existing members drawn upwards or downwards.

```
 Vertical member drawn upwards — plan, looking down −Z (x̂ = +Z toward the viewer):

              ẑ = +Y
                ^
        +-------|-------+
        |       |       |
        |       ⊙-------+-----> ŷ = +X
        |    x̂ = +Z     |
        |               |
        +---------------+          drawn downwards: x̂ = −Z, ŷ = −X, ẑ = +Y

 Horizontal member a → b along +X — elevation, looking north (+Y into the page):

        ẑ = +Z
          ^
          |   ŷ = +Y (into the page, ⊗)
   a o====+==============================> x̂ ======o b

 rotation θ = 90°:  ŷ → ẑ0 = +Z,  ẑ → −ŷ0 = −Y   (verified: variant "rot90", §12.4)
```

`rotationForDepth(a, b, dir)` returns the `rotation` that turns local `z`
onto `dir` for a member without a normal (`src/core/model/geometry.ts:235-242`). `facadeGrid` uses it with
`−n` for mullions and `+n` for transoms on custom planes. On XZ / YZ planes it
uses fixed values: mullion 0 / 90, transom 90 when `transomDepthNormal`
(`src/core/model/ops.ts:497-498`).

**Notes / caveats:**
- On a facade that is not vertical (sloped, V-shaped, curved), the default rule
  twists transoms and some mullions against the surface (world Z is not the
  facade's "up"). Orient the members to the surface instead of setting
  rotations by hand.
- The axes still change rule at the vertical threshold, now the same angle
  (5.7°) as the placement rules: a member leaning more is "inclined" for the
  rules too, and its local `z` is the projection of world Z.
- With `facadeGrid` on XZ, mullion local z is `+Y = −n`, while rotated
  transom local z is `−Y = +n` (`src/core/model/ops.ts:497-498`). "Side ±1"
  parameters therefore point opposite ways on mullions and transoms.

### 3.2 Alignment and offsets (`sectionShift`, `src/core/model/geometry.ts`)

```
grid mode:       shift.x (along ŷ) = −alignY·w/2 + offsetY        w = profile.b
                 shift.y (along ẑ) = −alignZ·h/2 + offsetZ        h = profile.h
insertion mode:  shift = (−insertion.x + offsetY, −insertion.y + offsetZ)
                 insertion = Profile.insertion, the profile's insertion point from its box centre
```

The mode is `Member.alignMode`. When it is absent, the member uses insertion mode if its
profile defines an insertion point, else grid mode. Earlier models therefore derive
unchanged. Insertion mode on a profile without an insertion point is grid mode
(`alignModeOf`). Connections place their parts from the section centre line and the
bounding-box faces, so they follow the shifted section. See
[PROFILES.md §2](PROFILES.md) for drawing coordinates and the role of the insertion point.

`Align` is −1 for the line at the section's negative edge, 0 for centre, +1
for the positive edge (`src/core/model/types.ts:52-53`).

```
 Section looking at the member end, x̂ toward the viewer: ŷ → right, ẑ ↑.  • = wire line, c = section centre

 alignZ = +1             alignZ = 0              alignZ = −1             alignY = −1, alignZ = 0
 +----•----+             +---------+             +---------+             +---------+
 |         |             |         |             |         |             |         |
 |    c    |             |    •    |             |    c    |             •    c    |
 |         |             |         |             |         |             |         |
 +---------+             +---------+             +----•----+             +---------+
 c = • − ẑ·h/2           c = •                   c = • + ẑ·h/2           c = • + ŷ·w/2
```

Verified: `alignZ = −1, offsetY = 20` on an upward SHS 100 at x = 500 gives
`shift = (20, 50)` and frame origin `(520, 50, 0)` (§12.4).

### 3.3 Extensions, trims and the physical ends (`memberGeom`, `src/core/derive/memberGeom.ts:38-90`)

```
eS, eE = applied extensions: startExt / endExt, or 0 at an end a connection
         governs (appliedExt, :42-45)
s0     = −eS + trimStart                                         (:57)
L      = |b − a| + eS + eE − trimStart − trimEnd                 (:58)
O      = a + x̂·s0 + ŷ·shift.x + ẑ·shift.y                        (:59-60)
frame  = { O, x̂, ŷ, ẑ },   length = max(0, L)                    (:69-70)
physical start = O,  physical end = O + x̂·length   (on the section centre line)
```

`trimStart` / `trimEnd` come from the connections' `trims()`. For each member
end, the **maximum** over all connections is used, not the sum
(`src/core/derive/model.ts:244-257`): coincident joints cut the member to the
governing face. This is intended; when two connections on one member end trim
by different amounts (more than 0.05 mm apart) derivation warns
"Start/End is cut back by n connections (…); the largest is used — check that
their parts do not clash" (`src/core/derive/model.ts:259-265`). Trims are
evaluated on untrimmed geometry (pass 1, `src/core/derive/model.ts:232-256`).
The parts are then built on trimmed geometry (pass 2,
`src/core/derive/model.ts:277-306`).

**Governed ends** (`src/core/derive/model.ts:209-231,253,266-275`): a member
end is governed by a connection when the member is one of its `secondary`
members and ends at its node, or when the connection trims that end (the
collinear member `main` of a splice, the upper mullion at a stack joint).
Connection parts are placed from the node (`centreAt`,
`src/core/connections/common.ts:172-175`; the base plate centre
`src/core/connections/basePlate.ts:42`), so the connection governs the end:
a user `startExt` / `endExt` there is **ignored** and derivation warns
"Start extension 30 mm is ignored: the Fin plate at that end sets the member
end." Free ends keep their extensions (variant "ext30/−20", §12.4, starts at
x = −30; variant "ext at fin plate", §12.4). Ignoring rather than following
the extension is the safer detailing choice: the plates stay on the main
member face, the slab or the stack-joint gap, and the member end stays where
the connection's trim and clearances put it.

### 3.4 End preparations (`src/core/geometry/endPrep.ts`)

`resolveEndCuts(p, m, frame, L, shape)` (`src/core/geometry/endPrep.ts:204-253`)
gives each end an `EndCut { kind, n, x, angleWeb, angleFlange, copes }`
(`:64-74`):

- `n` is the outward unit normal of the cut plane in member-local
  coordinates.
- `x` is where the cut plane crosses the section centre line.

The cut plane at section point `(y, z)` is at
`x(y,z) = x − (n_y·y + n_z·z)/n_x` (`cutXAt`, `:103-105`).

- **square**: `n = (∓1, 0, 0)` with `−` at the start; `x = 0` or `L` (`:78-80`).
- **bevel**: `n = norm(s, tan aF, tan aW)` with `s = −1` at the start and `+1`
  at the end (`:85-88`). At the start this gives `x = x0 + y·tan aF + z·tan aW`.
  A positive angle makes the +z (web angle) or +y (flange angle) edge shorter
  at that end (`:9-13`, `src/core/model/types.ts:97-104`). Angles are clamped
  to ±85° (`:82`).
- **mitre** (`mitrePlane`, `:149-166`):
  - `n_w = norm(d_B − d_A)`, where `d_A` and `d_B` are the directions from the
    shared node into each member's material.
  - `P` is the midpoint of the closest points of the two centre lines, when
    their gap is smaller than the largest section dimension. Otherwise `P` is
    the node projected onto A.
  - The plane passes through `P − n_w·gap/2`.
- **fit** (`fitPlane`, `:169-194`):
  - The candidate faces of B are `±ŷB` at `yPos` / `yNeg` and `±ẑB` at `h/2`.
  - On the web side, I sections use `tw/2` and U sections use `−w/2 + tw`
    (`:179-180`).
  - It picks the face whose outward normal best matches `d_A`, and needs a
    dot product of at least 0.2 (`:187-189`).
  - The plane passes through `onB + face·(dist + gap)`, where `onB` is the
    closest point on B's centre line. Its normal is `n = −face`.
- Mitre and fit planes are converted into the member frame. The normal
  becomes `n_l = (n_w·x̂, n_w·ŷ, n_w·ẑ)` and `x = ((P−O)·n_w)/(x̂·n_w)`
  (`:227-232`). The cut is rejected (end left square) if `s·n_lx < cos 85°`
  (`:229`).
- Copes are notches `{side, depth ≤ 0.45h, length, radius}`, on open sections
  only (`:237-247`).

When an end is prepared, `memberGeom` moves the origin to the start cut's axis
point and sets `length = end.x − start.x`. The cuts are re-based to
`start.x = 0` and `end.x = length` (`src/core/derive/memberGeom.ts:74-87`).
`cutEnvelope` gives `xMin` / `xMax`: the extreme material over the outline
(`src/core/geometry/endPrep.ts:259-268`). The **Part** (`linearPart`) then
moves its frame origin to `xMin` and uses
`Part.length = xMax − xMin` (overall stock length). The cut `x` values are
shifted by `−xMin` (`src/core/derive/model.ts:472-495`).

**Notes / caveats:** mitre and fit planes use the raw centre lines
(`centreLine`, `src/core/geometry/endPrep.ts:120-130`). They replace the
nominal end, so they override extensions **and** connection trims at that end
(`:200-203`). An end slot (§5.2) at such an end is measured from the cut end.

---

## 4. Connection placement

### 4.1 The `Connection` record and the build context

```ts
interface Connection { id; type; node: Id; main: Id | null; secondary: Id[]; params }   // src/core/model/types.ts:162-171
interface ConnCtx    { p; c; node: Vec3; v: params; geom(id): MemberGeom }               // src/core/connections/common.ts:111-118
```

- `node` is the joint. `ctx.node` is its position `N`
  (`src/core/derive/model.ts:238-243`).
- `main` is the supporting member, or `null` for concrete or reference
  supports (`src/core/model/types.ts:166-167`).
- `secondary[0]` is the supported member. Only the slab bracket uses
  `secondary[1..]` (stack-joint members to cut back,
  `src/core/connections/slabBracket.ts:84-92`).
- `v = resolveParams(c)`: the `ParamSpec` defaults overlaid with `c.params`
  (`src/core/connections/registry.ts:104-108`).
- `geom(id)` returns raw geometry in `trims()` and trimmed geometry in
  `build()` (`src/core/derive/model.ts:246,285`).

### 4.2 How connections get their node and members

`applyConnection(p, memberIds, {type, params, replace})`
(`src/core/connections/registry.ts:249-287`):

- `slabBracket` is delegated to `autoConnect`, with mullion brackets only
  (`:253-256`).
- **Types that need a main member** (`needsMain`, or a custom template with
  `needsMain`, `:259`) are tried at both member ends (`:266`):
  - `main` is a member at the node that passes **through** it and is not
    collinear; otherwise any non-collinear member (`:275`).
  - `COLLINEAR_TYPES` (`splicePlates`, `endPlateSplice`, `sleeveSplice`,
    `:52`) instead take a collinear member that ends at the node (`:274`).
  - `ONE_PER_NODE` types (splices, `crossBrace`, `:55`) are skipped when a
    same-kind connection already sits at the node (`:278-279`).
- **Types without a main member** use `endsFor(rule)` (`:78-95`) with
  `rule = APPLY_END[type](params) ?? 'lower'` (`:66-76`):
  - `lower` / `upper` by Z (`a.z ≤ b.z ⇒ start` is lower, `:81`).
  - `free`: no other profiled member at the node (`:83`).
  - `freeOrLower`: free ends; for vertical members, the lower end only if it
    is free (`:90-91`).
- Existing connections on the same member end (`node` and `secondary[0]`)
  are kept unless `replace` is set (`:260,268-269,282`).

`autoConnect(p, options)` (`src/core/connections/registry.ts:139-218`) works
node by node:

- **Mullion brackets** (`:153-174`):
  - With a mullion below the node: `slabBracket` with `mount: 'edge'` and
    `secondary = [below, above?]`.
  - Otherwise, with a mullion above it: `mount: 'top'`.
  - Both use `side = slabSide` and `standoff`.
- **Post bases**: at the bottom end of a vertical `post` (`:177-185`).
- **Joints** (`:188-215`):
  - Every non-vertical member that ends at the node gets `o.joint`.
  - `main` is chosen in this order: a through vertical member, a vertical
    member continuing upwards, any vertical member, any through member
    (`:195-199`).
  - Braces with an FL, L, CHS or RHS section get `braceJoint` (default
    `gussetPlate`) (`:201-205`).
  - When `main` ends at the node and the secondary's `ŷ` is near-vertical,
    `params.side = sign(ŷz)·(main continues up ? 1 : −1)` (`:206-212`).

### 4.3 Joint quantities shared by the builders

| Symbol | Definition | Source |
| --- | --- | --- |
| `dIn`, `end` | `inward(sec, N)`: the wire end nearer to `N`. `dIn = +x̂` at the start, `−x̂` at the end (from the node into the member) | `src/core/connections/common.ts:224-229` |
| `Cs` | `centreAt(sec, N) = O + x̂·((N−O)·x̂)`: `N` projected onto the section centre line | `src/core/connections/common.ts:172-175` |
| `halfExtent(g, d)` | `\|d·ŷ\|·w/2 + \|d·ẑ\|·h/2`: bounding-box support distance in the section plane | `src/core/connections/common.ts:178-180` |
| `face` | `faceDistance(main, Cs, dIn)`: distance along `dIn` from `Cs` to where the secondary's axis meets the main member's outer face (formula below) | `src/core/connections/common.ts:183-221` |
| `F` | Main face point on the secondary axis: `Cs + dIn·face` | e.g. `src/core/connections/memberJoints.ts:134,293`, `src/core/connections/custom.ts:105` |
| `depth_main` | `2·halfExtent(main, dIn)`: through-bolt depth of the main member | `src/core/connections/memberJoints.ts:234`, `src/core/connections/kit.ts:431` |
| joint | `jointOf` / `memberOf` bundle these (`Cs` included) | `src/core/connections/kit.ts:407-428` |

`face` is the real contact at the secondary's axis
(`src/core/connections/common.ts:183-221`), measured from `Cs` (the callers
pass `Cs`: `src/core/connections/kit.ts:415-416`,
`src/core/connections/memberJoints.ts:44`, `src/core/connections/custom.ts:46`):

```
C = centreAt(main, Cs),  rel = Cs − C
rectangular (box w × h):  n = the face normal among ±ŷm, ±ẑm closest to dIn  (outward, facing the secondary)
                          half = w/2 for ±ŷm, h/2 for ±ẑm
                          face = (half − rel·n) / (dIn·n)                 (Cs + dIn·face lies on that face)
round (CHS, RD, radius r = d/2):  q = rel ⊥ x̂m,  e = dIn ⊥ x̂m
                          face = (−q·e + √((q·e)² − e·e·(q·q − r²))) / (e·e)   (where the axis leaves the cylinder)
fallback (dIn·n < 0.2, |e| < 0.2 or the axis misses the tube): the box support plane
                          (C − Cs)·dIn + halfExtent(main, dIn)
```

For square framing (`dIn = ±ŷm` or `±ẑm`) all three give the same value as the
bounding-box support plane, so square joints are unchanged (§12.1 trim 60).
For a skewed secondary the face is now where its axis actually meets the
face: a transom at 30° in plan into an SHS 100 has `face = 50 / cos 30° =
57.74` (was 68.30, the support plane through the box corner); into a tube it
is the radius whatever the angle (was `(|cos| + |sin|)·r`). `gussetPlate`
picks its face the same way (`src/core/connections/bracing.ts:74-77`), as does
`fitPlane` for end preparations (`src/core/geometry/endPrep.ts:181-188`).
`flangeClamp` requires `|dIn·ẑm| ≥ 0.95` (`src/core/connections/steelJoints.ts:85`).

**Notes / caveats:**
- `face` is the contact **at the secondary's axis**. For a skewed secondary,
  one side of its section is closer to the main face than the axis; the trim
  `face + gap` does not add that `(w_sec/2)·tan θ`. Use a larger gap or a fit
  end preparation (§3.4) for strongly skewed members.
- `depth_main` (through-bolt grip) is still `2·halfExtent(main, dIn)`, the
  bounding-box depth along `dIn` — exact for square framing.

### 4.4 The joint end frame (U, V, W): custom templates

`customConnection.build` (`src/core/connections/custom.ts:99-105`):

```
U = dIn  (along the secondary, away from the main face)
W = ẑ_sec                 (up for a horizontal secondary)
V = W × U                 template frame 'joint' (default for new templates): right-handed,
                          V = ŷ_sec at the member's start node, −ŷ_sec at its end node
V = ŷ_sec                 template frame 'member' (templates saved before; set by migration)
O = Cs + U·face           (on the main face, on the secondary's section centre line)
```

Template variables: user parameters, `h_sec`, `b_sec`, `face`, `h_main`,
`b_main`, `depth_main = 2·halfExtent(main, dIn)`
(`src/core/connections/custom.ts:50-62`). Formulas use the safe evaluator
`evalExpr`: no `eval`, functions `max min abs round floor ceil ceilto sqrt`,
`x/0 = 0` (`src/core/connections/expr.ts:7-17,21,47`).

```
 plan view of a transom ending on a mullion (template frame)

        main member
     +-------------+
     |             |
     |      N •----|----O=========================> U = dIn
     |             |    |  secondary (section centre line)
     +-------------+    |
         <- face ->     v  (V = ŷ_sec at the start node; W = ẑ_sec out of page)
```

With `frame: 'joint'` (`CustomTemplate.frame`, `src/core/model/types.ts:238-246`)
`(U, V, W)` is right-handed at both ends (`U·(V×W) = +1`) and joint-local: the
joint at the end node is the joint at the start node turned 180° about `W`.
The same template at both ends of a transom gives the rotated copy — a plate
at `v = 30` lies at world `Y ∈ [30, 40]` at the start and `Y ∈ [−40, −30]` at
the end, both 20 mm from their main face (test "5. custom joint frame",
`tests/geometryFixes.test.ts`). Centred plates (`v = 0`) are mirror-symmetric
about the transom mid-length (§12.4, "custom both ends").

**Notes / caveats:** templates saved before this frame existed have no
`frame`; `migrateProject` sets `frame: 'member'` (`src/state/storage.ts:51,66-86`)
so their geometry does not change. There `V = ŷ_sec` at both ends: left-handed
at the end node (`U·(V×W) = −1`) and `v` member-local (an off-axis plate lies
on the same side of the member at both ends, mirror images about mid-length).
Plate frames stay right-handed either way because `plateOn` recomputes `z`.
The template editor can switch a template to the joint frame.

---

## 5. Plates

`PlateOut = { key, name, t, outline (frame x/y), holes: Hole2D[], frame, weldedTo?, assemblyMain? }`
(`src/core/connections/common.ts:48-59`).

### 5.1 Custom template planes (`buildPlate`, `src/core/connections/custom.ts:118-199`)

`place` (`CustomPlate.place`, `src/core/model/types.ts:201-208`) says where the
plate sits on its own normal: `'face'` (default, the original rule) puts its
contact face at the coordinate, `'centre'` its mid-plane (`b = −t/2` below,
`src/core/connections/custom.ts:135-137`).

| `plane` | Contact corner `P` (`b = 0` for `face`, `−t/2` for `centre`) | `n_out` | Plate x / y | Source |
| --- | --- | --- | --- | --- |
| `end` | `O + U·(u + b) + V·(v − width/2) + W·(w − height/2)` | `U` | `V` (width), `W` (height) | `:142-146` |
| `side` | `O + U·u + V·(v + b) + W·(w − height/2)` | `face`: `V·sgn(v)` (`v = 0 ⇒ +V`); `centre`: `+V` | `U` (width), `W` (height) | `:147-151` |
| `top` | `O + U·u + W·(w + b) + V·(v − height/2)` | `face`: `W·sgn(w)`; `centre`: `+W` | `U` (width), `V` (height) | `:152-157` |

For `end`, the plate is centred on `(v, w)` across the member and lies on
`U ∈ [u, u + t]` (`face`) or `[u − t/2, u + t/2]` (`centre`). For `side` and
`top`, `u` is where the plate **starts** along `U`; with `face` it grows away
from the member axis from its contact plane at `V = v` (resp. `W = w`), with
`centre` it straddles that plane (`V ∈ [v − t/2, v + t/2]`).

- **Bolts** (`:163-197`):
  - Grid `hx = width/2 + (c − (cols−1)/2)·gauge`,
    `hy = height/2 + (r − (rows−1)/2)·pitch`.
  - Head `= P + X·hx + Y·hy + n_out·t`, `dir = −n_out`.
  - With `through: main | secondary`: `grip = t + depth`, where
    `depth = 2·halfExtent(target, n_out)`. The member hole is at
    `contact − n_out·depth/2`.
  - With `through: concrete`: anchor kind, hole `d + 2`, `length = anchorLength`.
- **Weld**: `weldTo: main | secondary | <plate key> | none`.
  `assemblyMain = !weldTo` (`:161-162,198`).
- **Trim**: `face + cut`, applied to the end at the node (`:78-85`).

**Notes:** the starter template "Bolted end plate with stiffener" places its
stiffener with `v = '0'`, `place: 'centre'` (`src/core/connections/custom.ts:230`):
centred under the transom, world `Y ∈ [−4, 4]` for `ts = 8` (§12.4). Copies
saved with the old `v = '-ts/2'` (8 mm off-centre, `Y ∈ [−12, −4]`) are
recognised by `migrateProject` (template name, plate key `st`, plane `side`,
`t = ts`, `v = -ts/2`, no `place`) and centred; every other template keeps
`place` absent = `'face'` and loads unchanged (`src/state/storage.ts:66-86`).

### 5.2 Built-in plate placements (examples; full list in §10)

- **Fin plate** (`src/core/connections/memberJoints.ts:114-144`):
  - `ys = ŷ_sec·side`, `zs = ẑ_sec`.
  - `contact = w/2` (side) or `−t/2` (knife).
  - `P = Cs + ys·contact + dIn·face − zs·H/2`, so the plate starts at the
    main face.
  - Frame: `plateOn(P, ys, dIn, zs, t)`, outline `L × H` (`H = height || max(60, round(h_sec))`).
  - Holes at `(L − e, H/2 + o)`, `e = max(2·d0, 25)`.
  - `weldedTo` the main member.

```
 Fin plate, section with dIn towards the viewer (drawn for dIn = +x̂, side = +1: ys → right, zs ↑)

   position = side (contact = w/2)            position = knife (contact = −t/2)
   +--------+##                               +----|##|----+
   |  sec   |##  plate: ys ∈ [w/2, w/2+t]     |    |##|    |  plate: ys ∈ [−t/2, +t/2]
   |   •    |##  bolt head at ys = w/2+t      |  • |##|    |  bolt head at ys = w/2 (sec face)
   |        |##  grip = t + w                 |    |##|    |  grip = w
   +--------+##                               +----|##|----+  end slot t + 2 wide through the
            ^ dir = −ys                                     ^ dir = −ys     top and bottom walls
```

Elevation along `dIn`: the plate runs from the main face (`U = face`) to
`face + L`, with the bolt line at `ub = face + L − e`. The secondary is cut
back to `U = face + gap` (`:105-108`). With the knife position the plate runs
`L − gap` into the member, which gets an **end slot** (`endSlot`,
`src/core/connections/memberJoints.ts:133`): width `t + 2`, length
`L − gap + 5` from the member end, through the section along `zs`
(clearances `END_SLOT_CLEAR`, `src/core/connections/common.ts:232-248`;
derived part slots §6).

- **Slab bracket**: see §5.3.
- **End plate** (`src/core/connections/memberJoints.ts:288-310`): contact
  plane at `F = Cs + dIn·face`, `n_out = dIn`, axes `(ŷ_sec, ẑ_sec)`, centred
  on `F`, `weldedTo` the secondary.
- **Base plate** (`src/core/connections/basePlate.ts:36-59`): contact plane
  through `Pc = N + ŷ·shift.x + ẑ·shift.y`, normal to the member axis,
  `n_out = dIn`, axes `(ŷ, ẑ)`, centred on `Pc`.

### 5.3 Slab bracket (`src/core/connections/slabBracket.ts:94-233`)

Set-up (`:125-143`):

```
s     = sign(side)                    zN = ẑ·s   (towards the slab)
f     = sign(finSide)                 y  = ŷ·f   (the fin side of the mullion, default +ŷ)
up    = x̂·sign(x̂·Ẑ),  upSign = ±1      vWire = −shift.y·s   (wire line along zN, relative to C)
edge: C = centreAt(g, N + Ẑ·dz)       (dz default −100: world-Z offset, projected on the axis)
top : C = centreAt(g, N) + up·(backT + finH/2)
sideFace = C + y·w/2                  yFin = w/2 + finT/2     (fin mid-plane along y)
sb    = edgeSetback (default 20)      base plate set-back behind the slab edge (top mount)
so, sv, sa = surveyOut, surveyVert, surveyAlong
```

Parameters `finSide` (±1) and `edgeSetback` (mm) are at
`src/core/connections/slabBracket.ts:40,49`; their defaults give the geometry
of §12.2 unchanged. `finSide = −1` mirrors the fin, its bolts and the back
plate to the `−ŷ` face (test "8. slab bracket").

**Fin plate** (`:148-177`):

- Extents along `zN`: `v0 = −finBack`, and
  - edge: `v1 = vWire + standoff − backT + so`
  - top: `v1 = vWire + standoff + sb + backH + so`
- Extents along `x̂` (`u0..u1`):
  - top: `[−finH/2 + sv, finH/2]`, mirrored when `upSign < 0`
  - edge: `[−finH/2 + min(0, sv·upSign), finH/2 + max(0, sv·upSign)]`
- Frame: `P = sideFace + x̂·u0 + zN·v0`, `plateOn(P, y, x̂, zN, finT)`.
- Holes at `(u − u0, −v0)` for `u ∈ offsets(nb, pitch)`, slotted
  `finSlot` along the plate x (= member axis). The bolt line passes through
  the member centre line.

**Back plate**:

- edge (`:211-216`):
  - `slab = C + zN·(vWire + standoff + so) + up·sv + ŷ·sa`
  - `P = slab + y·(yFin − backW/2) − x̂·backH/2`
  - Frame: `plateOn(P, −zN, y, x̂, backT)`. The plate lies against the slab
    face and grows towards the mullion.
  - Anchor holes at `(ea, backH/2)` and `(backW − ea, backH/2)`, slotted
    along the plate x (= `y`, along the slab edge).
- top (`:195-200`):
  - `base = C − up·(backT + finH/2)` (node level)
  - `P = base + zN·(vWire + standoff + sb + so) + y·(yFin − backW/2) + ŷ·sa + up·sv`
  - Frame: `plateOn(P, up, y, zN, backT)`. It sits on the slab top, `sb`
    (`edgeSetback`, default 20 mm) behind the slab edge.
  - Anchor holes slotted along the plate y (`angle 90` = `zN`, out of plane).

**Bolts and anchors**:

- Fin bolts (`:178-191`): head `sideFace + y·finT + x̂·u`, `dir −y`,
  `grip finT + w`. Member hole at `C + x̂·u`, `dir y`.
- Anchors (`:201-229`):
  - edge: head on the back plate's front face `slab-face point − zN·backT`,
    `dir zN`.
  - top: head on the base plate's top face, `dir −up`.
  - Both: `grip backT`, `length anchorLen`.
- Trims: `secondary[1..]` are cut back at the node by `gap`
  (`:82-93`, auto value §9).
- Assembly: back plate `assemblyMain`, fin `weldedTo` the back plate (`:176,200,216`).
- The survey offsets move along the bracket's own axes: `so` along `zN`, `sv`
  along `up`, `sa` along the mullion's `+ŷ` (whatever `finSide`); the survey
  deviation is split on the same axes (§9.2).

```
 EDGE mount — plan at bracket level (side = +1: zN = ẑ = +Y; finSide = +1: y = ŷ = +X; x̂ = up, out of the page)

  zN ^
     |  ///////////////////////// concrete slab //////////////////////////
     |  ===================================================================  slab face: zN = vWire + standoff + so
     |                 |######### back plate, backW × backH ###########|     grows towards −zN by backT,
     |                 +------------------+----+-----------------------+     centred on ŷ = yFin
     |                                    |fin |
     |                                    |    |  fin top: zN = vWire + standoff − backT + so
     |                 +------------------+    |
     |                 |     mullion      |    |
     |                 |        C - - - - | o -|- -  bolt axis through C, dir −ŷ
     |                 |                  |    |     (nb bolts repeat along x̂, out of the page)
     |                 |                  +----+  fin bottom: zN = v0 = −finBack
     |                 +------------------+
     +-----------------------------------------------------------> ŷ
                                          ^ mullion +ŷ face (ŷ = w/2); fin ŷ ∈ [w/2, w/2 + finT]

 TOP mount — elevation looking along −ŷ (zN →, up ↑)
                                               slab edge: zN = vWire + standoff
    mullion                                    |
    +-----+-----------------------------------------------------------+  up = backT + finH
    |     |  fin on the mullion's +ŷ face                             |
    |  o  |  bolts at zN = 0 (through C), slots along up              |
    |  o  |                                                           |
    +-----+-----------------------------------------------------------+  up = backT (fin sits on the base plate)
    |     |                                    |    |### base plate ####|  up ∈ [0, backT] (+ sv)
    +-----+                                    |====+===================+====  slab top = node level
 ^ fin starts at zN = v0 = −finBack            |<sb>|<----- backH ----->|   sb = edgeSetback (20)
                                               |   concrete slab        |   (slabBracket.ts:149,197)
```

**Notes / caveats:**
- `edgeSetback` only moves the top-mount base plate and lengthens the fin; the
  auto anchor slot of the top mount is capped by the base-plate edge
  (`backH/2`, `src/core/movement/provisions.ts:308`), which does not depend
  on it. The concrete edge distance of those anchors is `sb + backH/2` minus
  half the slot — not checked against the anchor's `c_min` (the model does
  not know the real slab edge, `docs/CONNECTIONS.md` Limits).
- `finSide` follows the library brackets (`bracketFrame`, `kit.ts:463-475`).
- `dz` is a world-Z offset projected onto the member axis (`slabBracket.ts:137`).

---

## 6. Holes and slots

| Type | Meaning | Source |
| --- | --- | --- |
| `Hole2D {x, y, d, slot?, angle?}` | Plate hole in outline coordinates. `slot` is the **extra** length (overall `d + slot`). `angle` is in degrees from plate x towards plate y. The slot end centres are at `±slot/2` along `(cos a, sin a)` | `src/core/connections/common.ts:7-13`, `src/viewer/meshes.ts:65-89` |
| `WorldHole {pos, dir, d, slot?, slotDir?, through?}` | Hole in world space. `pos` is on the part's mid-plane or axis. `dir` is the drilling direction. `through: false` = one wall only, the one containing `pos` | `src/core/connections/common.ts:16-29` |
| `PartHole {x, y, z, face, d, slot?, slotAngle?, through?}` | Hole in a linear part frame. `face` is the axis drilled along. `slotAngle` (deg, in `(−90, 90]`) is the slot direction in the face plane, from local `+x` towards `+z` (face `y`) or `+y` (face `z`); absent = along `x`. `through: false` = one wall only | `src/core/derive/model.ts:19-39` |
| `WorldEndSlot {end, pos, normal, width, length}` → `PartSlot {end, face, x0, x1, offset, width}` | Open slot at a member end for an inserted plate: through the whole section along `face` (`= x̂ × normal`, snapped to `y` or `z`), `width` across centred on `offset`, from the end over `length` | `src/core/connections/common.ts:31-43`, `src/core/derive/model.ts:41-55` |

- **World point → plate hole**: `holeAt(pl, p, d, slot, slotDir)`. It takes
  `(x, y)` of `toLocal(pl.frame, p)` (any point on the hole axis), and
  `angle = atan2(sd·y, sd·x)` (default `sd = pl.frame.x`)
  (`src/core/connections/kit.ts:192-202`).
- **Member holes**: `memberHole` and `profileHole` (`src/core/connections/kit.ts:283-306`).
  Slots run along the member axis unless `memberHole` gets a `slotDir`
  (any direction in the drilled face); `through: false` makes a one-wall hole.
  `out.memberHoles` collects holes per member
  (`src/core/derive/model.ts:296-300`).
- **World holes → part holes**: `holesToLocal(frame, holes)`
  (`src/core/derive/model.ts:164-179`).
  - `l = toLocal(partFrame, pos)`.
  - `face = 'y'` if `|dir·ŷ| ≥ |dir·ẑ|`, else `'z'`.
  - Holes with `|dir·x̂| > 0.5` (axial) are skipped.
  - `slotAngle = atan2(slotDir·across, slotDir·x̂)`, `across = ẑ` (face `y`)
    or `ŷ` (face `z`), folded into `(−90, 90]`, omitted when 0
    (`slotAngleOf`, `:150-162`). `through: false` is kept.
  - Holes are sorted by `x`, `z`, `y`.
- **End slots → part slots**: `slotsToLocal` (`src/core/derive/model.ts:181-197`):
  the through axis `x̂ × normal` is snapped to `y` or `z` (warning when it is
  more than 2° off), `offset = l.y` (face `z`) or `l.z` (face `y`),
  `[x0, x1] = [0, length]` at the start or `[L − length, L]` at the end.
  Numbering includes slot angles, one-wall holes and end slots
  (`partSignature`, `:578-588`).
  - Member holes use the part frame (shifted to `xMin` for prepared ends,
    `src/core/derive/model.ts:315,331`).
  - Profile parts use their own frame (`:390`).
- Plates keep `Hole2D` as `Part.plateHoles` (`src/core/derive/model.ts:363`).

Consumers of the slot direction and walls:

- DSTV writes `l` slots with their direction (`holeLine`,
  `src/core/fabrication/dstv.ts:92-102`; called with `slotAngle` at `:225-236`).
- Hole table and machining: `HoleRow.angle = slotAngle` (`src/core/fabrication/machining.ts:44-48`);
  the operation text names the angle ("Ø14 × 34 long at 90°"), the part
  drawing's hole table shows it ("34 @90°") and draws the slot turned
  (`src/core/drawings/partDrawing.ts`).
- IFC: slot-shaped openings turned by the angle; depth from the walls the hole
  passes (§11).
- Connection preview: hole runs over the same walls, slot bar along the slot
  direction (`holeRuns`, `src/core/connections/preview.ts:437-453`).

All built-in member and profile slots still run along `x̂`
(`kit.ts:293,303`; `memberJoints.ts:231` uses `slotDir: dIn = ±x̂`); an
across-axis slot (test "6. slot directions") now reaches every output.

---

## 7. Bolts and anchors

`BoltOut = { key, size, grade, kind: 'bolt'|'anchor', length, grip, positions, dir }`
(`src/core/connections/common.ts:72-82`).

- `positions[i]` is the **head-side face of the grip**, and the shank runs
  along unit `dir` (`common.ts:79-81`). `addBolts` normalises `dir`
  (`src/core/connections/kit.ts:269-281`).
- The grip is the sum of the plies along `dir`, e.g. `t + w` for a fin plate
  through the secondary (`src/core/connections/memberJoints.ts:145`) or
  `t + depth_main` for through-bolts in the main member (`:311`).
- Bolt length: `boltLength(size, grip) = ceil_step(grip + 2·washer + nut + max(3, 0.3d))`,
  with step 5 when the result is ≤ 50 and 10 otherwise
  (`src/core/library/bolts.ts:182-186`). Example: M12 (washer 2.5, nut 10.8)
  with grip 60 gives 79.4 → 80.
- Anchors take their length from a parameter, or from
  `anchorLength(type, size, fixture, given, hef) = given || ceil5(h_ef + fixture + washer + nut + 5)`
  (`src/core/connections/kit.ts:124-130`). Anchor holes are the fixture hole
  from the fasteners library, otherwise `hole + 2` (`kit.ts:119-121`). The
  slab bracket always uses `hole + 2` (`slabBracket.ts:194`).
- Hole-to-bolt matching in code checks (`src/core/codes/checks.ts:181-198`).
  A hole counts as served by a bolt when its centre is within
  `d/2 + slot/2 + 1.5` of the bolt axis and its axial position from the head
  is in `[−5, grip + 5]`. Otherwise the size is "(assumed)" (`:217`).
- Viewer (`src/viewer/Viewer.ts:520-521`, `src/viewer/meshes.ts:108-118`):
  - The shank is a unit +Y cylinder mapped onto `dir`, from `pos` to
    `pos + dir·length`.
  - The head occupies `[pos − dir·head, pos]`.
- IFC (`src/core/io/ifcExport.ts:498-501`): the placement is at
  `pos − dir·head` with `Axis = dir`, extruded `length + head`.

---

## 8. Trims, welds, assemblies

- **Trims**:
  - `Trim {member, end, amount}`, positive = shorter
    (`src/core/connections/common.ts:95-99`).
  - `end` comes from `inward()` (the wire end nearer to `N`).
  - `amount` is typically `face + gap` (joints), a plate thickness (base and
    end plates), or half a gap (splices).
  - The maximum per end is used (`src/core/derive/model.ts:248-252`), then
    applied in `memberGeom` (§3.3). Intended: coincident joints cut the member
    to the governing face. Different amounts on one end raise a derivation
    warning (`:259-265`).
  - An end a connection trims or supports is governed by it: user extensions
    there are ignored (§3.3).
- **Welds**:
  - `PlateOut.weldedTo` and `ProfilePartOut.weldedTo` are part refs: `m:<memberId>`
    or `c:<connId>:<key>` (`common.ts:45-46`).
  - `ConnectionOut.welds` adds `[ref, ref]` pairs (`common.ts:91`).
  - A union-find over both builds the shop assemblies
    (`src/core/derive/model.ts:404-432`). Unknown refs are ignored without a
    warning (`:418`).
- **Assembly main** (`src/core/derive/model.ts:435-437`):
  - The first part with `assemblyMain` wins.
  - Otherwise: the lowest rank (member 0, profile 1, plate 2, `:569-571`),
    then the largest mass.
  - Mark prefix: the member's role prefix, `CL` for a profile, or
    `bracketPrefix` (default `BK`, `src/core/model/ops.ts:85`) for a plate (`:318-323`).
- **Material and finish** of connection parts come from the main member, or
  from `secondary[0]` when there is no main member
  (`src/core/derive/model.ts:344-346`).

---

## 9. Movement and survey adjustments

### 9.1 Slot and gap sizing

Auto slot (`deriveSlot`, `src/core/movement/slots.ts:45-58`). `H` is the
one-way demand: the tolerance stack `T`, plus movement `M`, plus the survey
residual `S`.

```
required  = 2·H + (H > 0.005 ? slotMargin : 0)
L_req     = ceil_inc(d0 + required)                (inc = slotIncrement, default 5)
s (extra) = min(L_req − d0, caps),  rounded to 0.1
caps: code long slot  L_long − d0                  (codeSlotCap, slots.ts:61-65; 2.5 d)
      edge            2·(e_edge − 1.5·d0)          (edgeSlotCap, slots.ts:72-75)
```

Tolerance stack (`toleranceStack`, `src/core/movement/tolerance.ts:39-50`):

- Linear sum `Σ|tᵢ|` or RSS `√Σtᵢ²` over the items in that direction.
- Structure-scope items (inferred from the name, `src/core/movement/settings.ts:44-51`)
  are left out for `scope: 'steel'` or when surveyed.
- Survey accuracy is added when surveyed.
- Thermal movement: `ΔL = α·ΔT·L` (`src/core/movement/thermal.ts:40-47`).

| Provision | `H` | Caps / rule | Source |
| --- | --- | --- | --- |
| Slab bracket fin slot (along the member) | `T(axis dir, design stack)` + `M` if the bracket slides. `M` = thermal over the distance to the fixed bracket + slab deflection if `\|Δz\| > 50` | code long slot (unless `slotCap: none`), edge `finH/2 − maxOff` | `src/core/movement/provisions.ts:247-257,195-204` |
| Slab bracket anchor slot | `T(along)` for edge mount, `T(out)` for top mount; `d0 = anchor.hole + 2` | edge: `anchorEdge` (edge mount), `backH/2` (top mount). Cast-in channel along the edge: 0 | `provisions.ts:304-311` |
| Stack-joint gap (`secondary[1]`) | `gap = max(minGap, ceil_inc(closing + T_steel,vertical + margin))`, `closing = ΔL⁺_upper(z_fixedU − z_N) + ΔL⁺_lower(z_N − z_fixedL) + δ_slab` (`δ_slab` only if `\|z_fixedU − z_fixedL\| > 50`) | — | `provisions.ts:445-478` |
| Fin plate / angle cleat thermal slot (movement end only) | `T_steel(dir) + ΔL_max(\|b−a\|)` | code long slot; edge `min(e, L−e)` (fin) or `g − gap` (cleat) | `provisions.ts:543-580`, `src/core/connections/memberJoints.ts:68-79` |

- The fixed bracket of a mullion is the one set `fixed`, otherwise the highest
  one not set `sliding` (`provisions.ts:175-181`).
- The movement end of a joint (`isMovementEnd`, `provisions.ts:514-529`) is
  only considered for non-vertical members with a joint at both ends. A joint
  is any connection with a main member at that end (`isMemberJoint`,
  `provisions.ts:485-493`: every `needsMain` type of the registry, the 22
  library joints included), plus custom templates as before. When the other
  end is not slottable (only `finPlate` and `angleCleat` are,
  `SLOTTABLE_JOINTS`, `:483`), this end slides. When both ends are slottable,
  the `end` node slides.
- Slots go into the fin plate holes along the plate x (`memberJoints.ts:141`)
  or, for angle cleats, into the supported member's holes along `dIn`
  (`memberJoints.ts:231`).

**Notes / caveats:** a member whose far end sits on a steel-to-concrete type
without a main member (e.g. `wallAngle`) still counts as having no joint
there, so no thermal slot is added at this end. The movement report flags
members jointed at both ends with no slot (`move.thermalEnd`,
`src/core/movement/report.ts:150-190`), now including library joints.

### 9.2 Survey offsets (slab brackets only)

`surveyOut` (`so`), `surveyVert` (`sv`) and `surveyAlong` (`sa`) move the
slab bracket's back plate (§5.3):

- `so` shifts the slab-face plane along `zN` and lengthens the fin
  (`slabBracket.ts:149,197,212`).
- `sv` shifts the back plate along `up`, and the fin's `u` range follows it
  (`:154-161,197,212`).
- `sa` shifts the back plate along `ŷ` only (`:197,212`), on either fin side.
  A warning is raised if `|sa| > backW/2 − finT` (`:144`).

Matching (`src/core/survey/match.ts`):

1. **Design reference point** (`bracketReference`, `src/core/connections/slabBracket.ts:252-270`):
   - `P_ref = centreAt(g, N) + zN·(vWire + standoff) + ŷ·finSide·(w/2 + finT/2)`
   - Directions: `out = zN`, `vertical = up` (the member axis pointing up),
     `along = ŷ` — the axes `so`, `sv` and `sa` are applied along, an
     orthonormal frame. For a plumb mullion they equal the horizontal
     projections and world Z used before.
2. **Pairing**: nearest-first and one-to-one, within `matchRadius`
   (`match.ts:66-90`).
3. **Deviation**: `deviation = (p_meas − p_design)·{out, vertical, along}`
   (`:56-59`), and `residual = deviation − applied` (`:118`).
   `along` is only used with `survey.applyAlong` (`:95`).
4. **Adjustability left**: `available = provided/2 − (tol + move)` (`:132`).
5. **`applySurvey`** (`:184-211`):
   - In mode `exceeding`, a direction is written only if `|dev| > 0.5` and
     `|dev| > max(0, available) + 0.05`.
   - In mode `all`, every matched direction is written.
   - The written value is `round(dev/step)·step`, with step
     `survey.adjustStep` (default 5).

Because the deviation is decomposed on the same axes the geometry moves along
(`slabBracket.ts:262-269`), applying all three directions moves the back plate
by exactly the measured deviation, also on a leaning mullion (test "7. survey
offsets": 300 mm lean, deviation (5, 20, −10) reproduced within 0.01 mm; the
old horizontal split was off by more than 1 mm).

**Notes / caveats:** `P_ref` is at node level, while an edge-mounted bracket
sits at `N + dz` (`slabBracket.ts:137,261`). That is documented as intended
(`slabBracket.ts:237`). "Vertical" is the mullion direction, not world Z: on
a leaning mullion a pure level difference shows partly as `out` (and
`along`).

---

## 10. Per-type placement

Symbols as in §4.3. Bracket family (`bracketFrame`, `src/core/connections/kit.ts:463-475`):

- `C = centreAt(g, N + dIn·along)`, `zN = ẑ·side`, `y = ŷ·finSide`
- `D = −shift.y·side + standoff` (the concrete face is `C + zN·D`)
- `up = x̂·sign(x̂·Ẑ)` if `|x̂·Ẑ| > 0.5`, else `dIn`

`throughMember` (`src/core/connections/concreteBrackets.ts:51-63`): heads at
`C + up·u + zN·zOff + y·(w/2 + plies)`, `dir −y`, `grip plies + w`, member
holes on the centre line.

Plate notation in the tables below: `[P | n_out | x, y]` means
`plateOn(P, n_out, x, y, t)` (§2.1).

### 10.1 Original types

| Type | Members | Plates / profiles | Bolts / holes | Trim |
| --- | --- | --- | --- | --- |
| `slabBracket` (`slabBracket.ts:32`) | sec[0] mullion; sec[1..] cut back | §5.3 (`finSide`, `edgeSetback`) | fin bolts `−ŷ·finSide`; anchors `zN` (edge) / `−up` (top) | sec[1..]: `gap` (`:82-93`) |
| `baseplate` (`basePlate.ts:6`) | sec[0] post | `[Pc − ŷW/2 − ẑL/2 \| dIn \| ŷ, ẑ]`, `Pc = N + ŷ·shift.x + ẑ·shift.y`, `W = width ‖ ceil10(w+2e+40)`, `L = length ‖ ceil10(h+2e+40)`, welded to post (`:36-59`) | 4 anchors at `e` from the corners, head `+dIn·t`, `dir −dIn`, `grip t` (`:45-69`) | `t` (`:21-25`) |
| `finPlate` (`memberJoints.ts:86`) | main + sec | §5.2 | head `Cs + ys·(w/2 + t)` (side) or `ys·w/2` (knife), `+dIn·ub + zs·o`, `dir −ys`; sec hole `Cs + dIn·ub + zs·o`, `ub = face + L − e` (`:145-158`); knife: end slot in sec, `t + 2` × `L − gap + 5` (`:133`) | `face + gap` (`:105-108`) |
| `angleCleat` (`memberJoints.ts:165`) | main + sec | L frame `{K + yp·b/2 + zp·h/2 − xp·Lc/2; xp = dIn×zp, yp = dIn, zp = ŷ·side}`, `K = Cs + zp·w/2 + dIn·face`: b-leg along the sec side, h-leg on the main face (`:203-209`) | sec: head `K + yp·g + xp·o + zp·t`, `dir −zp`, `grip t + w`, sec hole slotted along `dIn` at the movement end; main: head `K + zp·g + xp·o + dIn·t`, `dir −dIn`, `grip t + depth_main` (`:217-251`) | `face + gap` (`:183-186`) |
| `endPlate` (`memberJoints.ts:259`) | main + sec | `[F − ŷW/2 − ẑH/2 \| dIn \| ŷ, ẑ]`, welded to sec (`:288-310`) | 2 columns at `±(w/2 + edge)`, head `+dIn·t`, `dir −dIn`, `grip t + depth_main`; main holes at `−dIn·depth/2` (`:296-321`) | `face + t` (`:273-276`) |
| `welded` (`memberJoints.ts:328`) | main + sec | none; `welds: [sec, main]` (`:342`) | — | `face + gap` (`:334-337`) |
| `splicePlates` (`splice.ts:10`) | main a, sec b collinear | 2× `[C + ŷ·(±w/2) − dB·L/2 − ẑ·H/2 \| ±ŷ \| dB, ẑ]`, `C = centreAt(b, N)`, loose (`splice.ts:58-71`) | `s = ±(gap/2 + e + i·pitch)`, `e = max(2d0, 30)`; head `C + dB·s + ŷ(w/2 + t)`, `dir −ŷ`, `grip 2t + w`; slot on the `s < 0` (member a) plate holes (`:53-86`) | `gap/2` on both (`:26-33`) |
| `custom` (`custom.ts:66`) | per template | §5.1 | §5.1 | `face + cut` (`:78-85`) |

### 10.2 Steel to concrete (`src/core/connections/concreteBrackets.ts`)

| Type | Placement | Bolts / anchors | Trim |
| --- | --- | --- | --- |
| `helpingHand` (`:75`) | Angle heel `C + zN·D + y·w/2 − up·L/2`; `placeAngle(heel, up, L, legB = y, legH = −zN)`: wall leg on the concrete face, projecting leg on the member side (`:115-118`) | member: `throughMember` with `zOff = D − gM`; angle holes slotted along the angle axis when sliding (`:114,123-132`); anchors head `C + up·u + y·(w/2 + gA) + zN·(D − a.t)`, `dir zN` (`:139-152`) | — |
| `castInChannel` (`:174`) | edge: back `[C + zN·D + y(yc − W/2) − up·H/2 \| −zN \| y, up]`, fin `[C + y·w/2 − zN·finBack − up·finH/2 \| y \| zN, up]` (`:233-262`). top: base `[C − up(backT + finH/2) + y(yc − W/2) + zN(zc − H/2) \| up \| y, zN]`, `zc = D + chanEdge`, fin on the base plate (`:263-296`) | T-bolts (anchor kind) on the channel line `y = yc ± tPitch/2`, head at the plate face, `dir zN` / `−up`; slots: back across the channel (`up` / `zN`), fin `zN` (edge) / `up` (top) (`:246-306`) | — |
| `embedPlate` (`:319`) | edge: embed `[C + zN·D + y(yc − W/2) − up·H/2 \| +zN (into concrete) \| y, up]`; top: `[C − up·finH/2 + … + zN(D + 50) \| −up \| y, zN]`; fin as castInChannel, shop weld → `weldedTo embed`, else loose `assemblyMain` (`:370-409`) | studs (anchor kind) head on the embed face, `dir` into the concrete, `length studLen + tE` (`:373-397`); fin holes slotted along `up` (`:410`) | — |
| `soffitHanger` (`:423`) | `up = −dIn`; soffit plate `[Cn − ŷW/2 − ẑLp/2 \| dIn \| ŷ, ẑ]`, `Cn = centreAt(g, N)`; fins `[Cn + dIn·tP ± ŷ·w/2 − ẑ·finW/2 \| ±ŷ \| ẑ, dIn]` (`:476-532`) | anchors head `+dIn·tP`, `dir up`; bolts at `Cn + dIn·(tP + s)`, `s0 = gap + max(eTop, e + 10)`, slotted along `dIn`, `grip n_fins·finT + w` (`:496-543`) | `plateT + gap` (`:449-452`) |
| `wallAngle` (`:557`) | Wall plane through `N ⟂ dIn`; heel `Cn + ys·w/2 − ẑ·L/2`; `placeAngle(heel, ẑ, L, legB = ys, legH = dIn)` (`:605-606`) | member: head `Cn + dIn·gM + ẑu + ys(w/2 + a.t)`, `dir −ys`, member slot `slotH` along `x̂`, angle slot `slotV` along the angle (`:613-622`); anchors head `+dIn·a.t`, `dir −dIn` (`:631-640`) | `gap` (`:579-582`) |
| `adjustableBracket` (`:656`) | wall angle heel `C + zN·D + up·heelUp + y·w/2`, `heelUp = −finH/2 − tB − a.t`, along `y`, `legB = up`, `legH = −zN`; slide `[C − up·finH/2 − zN·finBack + y·w/2 \| −up \| zN, y]`; fin `[C + y·w/2 − zN·finBack − up·finH/2 \| y \| zN, up]` (`:709-745`) | slide-to-angle `dir up`, slotted along `zN`; fin slotted along `up`; member `plies finT + tS`; anchors slotted along `y`, `dir zN`; optional serrated plates (`:746-798`) | — |
| `stiffenedBase` (`:810`) | as baseplate (`:849-860`); gussets for the first 2 or 4 of `±ŷ, ±ẑ`: `[centre + f·half + dIn·t − n̂·tg/2 \| n̂ \| f, dIn]`, `n̂ = norm(f × dIn)`, welded to the plate and the post (`:885-917`) | 4 or 6 anchors, head `+dIn·t`, `dir −dIn` (`:861-883`) | `t` (`:830-833`) |
| `anchorPlate` (`:930`) | `[Cn − ŷWp/2 − ẑH/2 \| dIn \| ŷ, ẑ]`, anchors at `(±(w/2 + c), ±(h/2 + c))` per pattern; fin variant `[Cn + ŷw/2 + dIn·t − ẑ·finH/2 \| ŷ \| dIn, ẑ]` (`:976-1029`) | anchors head `+dIn·t`, `dir −dIn`; fin bolt at `Cn + dIn·(t + gap + e + slot/2)`, slotted along `dIn` (`:997-1033`) | `t` (`+gap` with fin) (`:952-957`) |

### 10.3 Steel to steel (`src/core/connections/steelJoints.ts`)

| Type | Placement | Bolts / holes | Trim |
| --- | --- | --- | --- |
| `flangeClamp` (`:61`) | Main I/U, `\|dIn·ẑm\| ≥ 0.95`. `Fm = centreAt(main,N) + dIn·halfExtent(main,dIn)`, `A = ŷm`, `Lm = x̂m`, `sl = (Cs − Fm)·Lm`. Top `[Fm − A·W/2 + Lm(sl − L/2) \| dIn \| A, Lm]` welded to sec; clamp plates at `Fm − dIn·tf`, `n_out −dIn`; packers `t = tf` (`:85-152`) | bolts outside the flange tips at `Fm ± A·oc + Lm(sl + u)`, `oc = bf/2 + clear + d/2`; head `+dIn·t`, `dir −dIn`; no member holes (`:99,120-162`) | `face + t` (`:77`) |
| `doubleAngle` (`:172`) | for `s = ±1`: `zp = s·ŷ`, `xs = dIn × zp`, `K = Cs + zp·w/2 + dIn·face`, `placeAngle(K − xs·Lc/2, xs, Lc, legB = dIn, legH = zp)` (`:213-219`) | main per side: head `K + zp·g + xp·o + dIn·a.t`, `dir −dIn`; sec once: head `Cs + dIn(face + g) + xp·o + ŷ(w/2 + a.t)`, `dir −ŷ`, `grip 2a.t + w` (`:221-238`) | `face + gap` (`:187`) |
| `teeCleat` (`:252`) | `placeTee(faceC, ẑ, out = −dIn, width = ys)`, `faceC = Cs + dIn·face + ys·stemOff − ẑ·Lc/2`, `stemOff = 0` (knife) or `w/2 + tw/2`; the flange outer face lies on the main face (`:291-302`, `kit.ts:371-380`) | flange: `Cs + dIn·face + ys(stemOff ± gf) + ẑo`, head `+dIn·tf`, `dir −dIn`; stem: `Cs + dIn(face + gs) + ẑo`, head `ys·w/2` or `ys(w/2 + tw)`, `dir −ys` (`:307-334`); knife: end slot in sec `tw + 2` × `h_tee − tf − gap + 5` unless the stem fits inside a hollow sec (`:297`) | `face + tf + gap` (`:268`) |
| `seatedAngle` (`:355`) | `nb` = most downward of `±ŷ, ±ẑ` (`:344-348`), `across = dIn × nb`; seat (`n = nb`) and optional top cleat (`n = −nb`): `placeAngle(Cs + dIn·face + n·hb − across·Ls/2, across, Ls, legB = dIn, legH = n)` (`:403-407`) | main head `+dIn·a.t`, `dir −dIn`; vertical: head `−nb(hb [+ a.t])`, `dir nb`, `grip 2hb + a.t·n` (`:408-432`) | `face + gap` (`:372`) |
| `stubBracket` (`:446`) | stub `sectionFrame(Cs + dIn·face, dIn, sec)` length `Ls`, welded to main; plates `[Cs + dIn·u − YW/2 − ZH/2 \| dIn \| Y, Z]` at `u = face + Ls` (welded to stub) and `face + Ls + t` (welded to sec) (`:485-508`, `kit.ts:383-389`) | head `Cs + Y·by + Z·bz + dIn(face + Ls + 2t)`, `dir −dIn`, `grip 2t` (`:509`) | `face + Ls + 2t` (`:461`) |
| `saddleBracket` (`:522`) | `A = norm(dIn × x̂m)`, `M = norm(A × dIn)`, `uFar = (centreAt(main,N) − Cs)·dIn − halfExtent(main,dIn)`; back `[Cs + dIn·uFar − A(Hin + t) − M·Hs/2 \| −dIn \| A, M]`; sides `[Cs + s·A·Hin + dIn·uFar − M·Hs/2 \| s·A \| dIn, M]` (`:550-596`) | at `Cs + dIn·(face + gap + e + i·p)`, head `+A(Hin + t)`, `dir −A`, `grip 2t + 2Hin`; optional main bolt at `Cs + dIn·cM` (`:566-603`) | `face + gap` (`:538`) |
| `shearBlock` (`:615`) | RHS sec only; `[Cs + ŷ·y0 + dIn·face − ẑ·hi \| ŷ \| dIn, ẑ]`, block `y0 = −tb/2`, twin `y0 ∈ {wi − tp, −wi}`, welded to main (`:659-683`) | head `+ŷ·w/2`, `dir −ŷ`, `grip w`; sec holes slotted along `x̂` (`:684-685`) | `face + gap` (`:632`) |
| `endCap` (`:693`) | `[Cn − ŷW/2 − ẑ(H or W)/2 \| dIn \| ŷ, ẑ]`, `W = w + 2ov`; circle for CHS; vent hole at `Cn` (`:719-736`) | — | `t` (`:704-707`) |

### 10.4 Splices, bracing, hangers

| Type | Placement | Bolts / holes | Trim |
| --- | --- | --- | --- |
| `endPlateSplice` (`spliceJoints.ts:50`) | `C = centreAt(b,N)`; plates `[C + dB·u − YW/2 − ZH/2 \| dB \| Y, Z]`: `u = pack/2` (welded to b), `−pack/2 − t` (welded to a), pack at `−pack/2` (`:90-108`) | head `+dB(pack/2 + t)`, `dir −dB`, `grip 2t + pack` (`:109-116`) | `t + pack/2` on both (`:65`) |
| `sleeveSplice` (`spliceJoints.ts:158`) | sleeve `sectionFrame(C − dB·Ls/2, dB, b)`, length `Ls`, centred on `N` (`:212-214`) | at `C + d·u`, `u = gap/2 + e + i·p` per side; head `+Y·max(w)/2`, `dir −Y`; sleeve holes slotted on the sliding side (the upper member if vertical, `:206-207,216-233`) | `gap/2` on both (`:174`) |
| `gussetPlate` (`bracing.ts:132`) | `nG = norm(x̂m × dIn)` (towards `ŷs`); `n` = main face normal; `O` on the main face (`:65-77`); gusset `[O + nG((Cs−O)·nG + contact) \| side·nG \| x̂m, n]`, outline = hull of the weld base and bolt capsule (`:164-175`); tubes: knife `[Cs + dIn·tip − wdir·kW/2 − nG·tk/2 \| nG \| dIn, wdir]` (`:184-199`), end slot in the tube `tk + 2` × `insert + 5` (`:202`) | holes slotted along `dIn`; head `p + nG(contact + side·t − (p−Cs)·nG)`, `dir −side·nG`, `grip t + tPart` (`:177,206-216`) | flat/angle `clearAt(halfW)`, tube: last bolt + edge + 5 (`:89-111`) |
| `crossBrace` (`bracing.ts:294`) | `nG = norm(x̂a × x̂b)`; in-plane members at the node joined; plate `[N + nG·side·contact \| side·nG \| ax, nG × ax]`, `contact = max halfExtent(m, nG)` (`:235-240,323-350`) | through member: `±p/2` around `N`; split members after the trim; head `p + nG(side(contact + t) − (p−N)·nG)`, `dir −side·nG`, `grip t + 2contact` (`:267-285,351-363`) | split members: `(tHalf + gap + half·\|wdir·nt\|)/sinθ` (`:276-283`) |
| `hangerRod`, `tieBack` (`hangers.ts:181,216`) | `nL = norm(dIn × x̂m)`, `wL = norm(nL × dIn)`, `at(u,y,w) = Cs + dIn(face + u) + nL·y + wL·w`; lug `[at(0, yL − tl/2, −Wl/2) \| nL \| dIn, wL]` welded to main; fork boss/cap ⟂ `dIn` at `uEnd` + cheeks at `±nL·yc`; tab/tongue at `nL·(−tp/2)` with the lug offset `yL = −(tp + tl)/2` (`:48-157`); tongue: end slot in the strut `tp + 2` × `insert + 5` (`:159`) | pin hole `P0 = at(uPin, 0, 0)` slotted along `dIn`; head `P0 + nL·headY`, `dir −nL`, `grip 2(tp + 1.5) + tl` (fork) or `tp + tl` (`:103-171`) | `face + trim` (`:83-86`, `trim` `:67-78`) |

**Notes / caveats:**
- Plates inserted into the secondary's end — the knife fin plate, the gusset
  knife in a tube brace, the tie-back tongue and a tee stem that does not fit
  inside a hollow secondary — cut an **end slot** into it (`endSlot`,
  `src/core/connections/common.ts:232-248`): width `t + 2`, length engagement
  past the member end `+ 5` (typical clearances), through the whole section
  across the plate. It becomes a `PartSlot` (§6) shown in 3D, cut in IFC,
  notched into the DSTV contours, listed in the machining steps and drawn on
  the part drawing (§11). An open-section secondary with a knife has its web
  removed over the slot length (the plate lies in the web plane).
- `side` / `finSide` of the built-in types are member-local, so mirrored
  joints at the two ends of a member are not mirror images in the joint view.
  Custom templates with the joint frame are joint-local (§4.4).

---

## 11. Consumers of the frames

| Consumer | Mapping | Source |
| --- | --- | --- |
| Three.js linear part | `linearMatrix`: basis columns `[ŷ, ẑ, x̂·length]`, translation `origin`. The section outline (x → ŷ, y → ẑ) is extruded along +Z with depth 1. Prepared members use `length = 1` with exact cut geometry; members with end slots use `length = 1` with the slot strip clipped out of the section over the slot length (`slottedMemberGeometry`; tubes exact, open sections joined by zero-width bridges; slots on prepared ends are not drawn) | `src/viewer/meshes.ts:38-56,239-304,390-398` |
| Three.js plate | `plateMatrix`: columns `[x, y, z]`, `origin`. The outline is extruded along +Z by `t`, and holes are cut as `slotOutline` | `src/viewer/meshes.ts:58-63,95-105` |
| IFC linear part | `IfcLocalPlacement(IfcAxis2Placement3D(origin, Axis = x̂, RefDirection = ŷ))`, so IFC local `(X, Y, Z) = (ŷ, ẑ, x̂)`. Parameterised profile extruded `length` along Z; prepared ends use boolean clipping | `src/core/io/ifcExport.ts:405-407` |
| IFC plate | `IfcAxis2Placement3D(origin, Axis = z, RefDirection = x)`, so `(X, Y, Z) = (x, y, z)`. Arbitrary profile with voids, extruded `t` | `src/core/io/ifcExport.ts:386-391,330-336` |
| IFC holes in linear parts | Placed in the host placement, axis = the drilling axis (host X = ŷ for face y, host Y = ẑ for face z), RefDirection host Z (= x̂). Extent along the axis from the section walls the hole passes (`holeWalls`, `src/core/geometry/sectionWalls.ts:29-43`): through holes from the first to the last wall on their line, one-wall holes (`through: false`) only their wall, `± 5` margin. Round, or slot-shaped (`IfcArbitraryClosedProfileDef`) turned by `slotAngle` | `src/core/io/ifcExport.ts:440-472` |
| IFC end slots | Rectangle `(x1 − x0 + 5) × width` (run 5 past the open end), extruded through the section (`H + 10` or `w + 10`) along the slot's `face` axis, centred on `offset` | `src/core/io/ifcExport.ts:473-484` |
| IFC spatial chain | site → building → storey all identity, so placements are world coordinates. Storeys carry the elevation only; elements are grouped by the storey of their origin Z | `src/core/io/ifcExport.ts:173-192,301-321` |
| DSTV linear | x from the part frame origin (the physical or extreme start). Faces: `v` front (local −y side), `h` back (+y), `o` top (+z), `u` bottom (−z). face y → `v` with `y_v = z + h/2`; face z → `o` with `y_o = y + b/2`; one-wall holes on the face of their wall (`h` for y > 0, `u` for z < 0). Hollow-section (RHS, CHS) through holes: once on `v` / `o` (setting `dstvHollowThrough: 'one'`, default, drill through both walls) or on both faces `v + h` / `o + u` (`'both'`). Slots `l` with their `slotAngle`. Saw angles web start/end and flange start/end in the ST header. Coped contours on `v`, `o`, `u`; end slots as rectangular notches in the `AK` contours of the faces they cut (`o + u` for slots through z, `v + h` through y; a face with a cope contour keeps the cope contour) | `src/core/fabrication/dstv.ts:166-168,191-237,242-256` |
| DSTV plate | Profile code `B`. `AK` contour and `BO` holes on face `v`, relative to the outline bounding-box minimum. Slots `l` along x, along y (angle ±90), or at an angle | `src/core/fabrication/dstv.ts:130-138,174-183,92-102` |
| Hole table / machining | Same faces and origins as DSTV (`v` / `o`). `slotLength = slot + d`, `angle = slotAngle`; one-wall holes say so; end slots are an "End slot" step (width × length from which end, through which walls, centre offset) | `src/core/fabrication/machining.ts:35-64,79-105` |
| Drawings | Part elevation is local x–z, looking along local +y (the −y side faces the viewer). Plan is local x–y from above. Plates are drawn in outline coordinates with the bounding-box datum. Prepared ends via `sideProfile` / `flangeProfile`. Slots drawn at their angle, hole table "Slot" column with the angle; end slots drawn as the notch outline in the view looking through them (plan for face z, elevation for face y), the slot bottom hidden in the other view, plus an "End slots" table | `src/core/drawings/partDrawing.ts:4-7,102-114,154-167`, `src/core/drawings/views.ts:61-65,283-314` |

**Notes / caveats:** the DSTV face letters, the `h` / `u` coordinates (same
`y` as `v` / `o`) and the end-slot notch convention must be checked against
the target machine's post-processor (as the saw angles). Round tubes (code
`RO`) use the same four faces as boxes. One IFC opening per hole spans all the
walls of a through hole (the cavity between them included).

---

## 12. Worked example (real output)

Model, built in a temporary Vitest file with `createProject`, `addLine`,
`addConnection` and `deriveModel`. Defaults apply unless listed.

- Mullion `SHS 100x100x5`, role `mullion`: (0,0,0) → (0,0,3500).
- Transom `RHS 100x50x4`, role `transom`, `rotation 0`: (0,0,1500) →
  (1500,0,1500). Its start node lies on the mullion, so the mullion is
  `through` that node.
- `slabBracket` at the bottom node: `{mount: 'top', side: 1, standoff: 150}`.
  These are the parameters `autoConnect` gives a bottom node
  (`registry.ts:165-172`). `applyConnection('slabBracket')` would also add an
  edge-mount bracket at the top node.
- `finPlate` at the transom start, `main` = mullion.

No warnings were produced (`dm.warnings = []`).

### 12.1 Members

| | Mullion | Transom |
| --- | --- | --- |
| `a`, `b` | (0,0,0), (0,0,3500) | (0,0,1500), (1500,0,1500) |
| `x̂, ŷ, ẑ` | (0,0,1), (1,0,0), (0,1,0) — vertical rule | (1,0,0), (0,1,0), (0,0,1) |
| `h`, `w`, `shift` | 100, 100, (0,0) | 100, 50, (0,0) |
| trims | 0 / 0 | **60** / 0 |
| frame origin | (0,0,0) | **(60,0,1500)** |
| physical end / cut length | (0,0,3500) / 3500 | (1500,0,1500) / **1440** |
| part holes | x = 50 and 120, y = z = 0, face y, d 13 | x = 64, z = −25 and +25, face y, d 13 |
| DSTV `BO` | `v 50 s 50 13`, `v 120 s 50 13` | `v 64 s 25 13`, `v 64 s 75 13` |

Transom trim:

- `face = (centreAt(mullion,N) − N)·dIn + |dIn·ŷm|·50 + |dIn·ẑm|·50 = 0 + 50 + 0 = 50`.
- `trim = face + gap = 60` (§4.3, `memberJoints.ts:105-108`).
- So `O = a + x̂·60` and `L = 1500 − 60` (§3.3).

DSTV `y_v = z + h/2` gives 25 and 75 for the transom, and 0 + 50 = 50 for
the mullion (§11).

### 12.2 Slab bracket (top mount)

Set-up (§5.3):

- `zN = (0,1,0)`, `up = x̂`.
- `C = (0,0,0) + up·(10 + 75) = (0,0,85)`.
- `vWire = 0`, `sideFace = (50,0,85)`, `yFin = 55`.

Fin plate:

- `v0 = −40`, `v1 = 150 + 20 + 150 = 320`, so the fin is 360 along `zN`.
- `u ∈ [−75, 75]`, so it is 150 along `x̂`.
- `P = sideFace + x̂·(−75) + zN·(−40) = (50, −40, 10)`.

| Part | frame origin | x / y / z | outline | world extents |
| --- | --- | --- | --- | --- |
| fin (t 10, welded to back) | **(60,−40,10)** | (0,0,1) / (0,1,0) / (−1,0,0) | 150 × 360 | X 50…60, Y −40…320, Z 10…160 |
| back (t 10, `assemblyMain`) | (−25,170,0) | (1,0,0) / (0,1,0) / (0,0,1) | 160 × 150 | X −25…135, Y 170…320, Z 0…10 |

- Fin: `plateOn(P, ŷ, x̂, zN)` gives `z = x̂ × zN = (−1,0,0)`. That points
  away from `n_out = ŷ = +X`, so the origin moves `+ŷ·10` to (60,−40,10). The
  contact face X = 50 (the mullion's +y face) is at frame `z = t` (§2.1).
- Back plate: `base = C − up·85 = (0,0,0)`. The origin is
  `base + zN·(150 + 20) + ŷ·(55 − 80) = (−25,170,0)`. Its `z = +Z` points
  along `n_out = up`, so the origin is unchanged.

Holes and bolts:

- Fin holes: `(40, 40)` and `(110, 40)`, `d 13`, `slot 17`, `angle 0` (along `up`).
  Their mid-thickness centres are (55,0,50) and (55,0,120).
- Back plate holes: `(35, 75)` and `(125, 75)`, `d 15` (`13 + 2`), `slot 55`,
  `angle 90` (along `zN`). In world coordinates: (10,245) and (100,245).
- Fin bolts: M12 at (60,0,50) and (60,0,120), `dir (−1,0,0)`,
  `grip 10 + 100 = 110`, length `ceil10(110 + 5 + 10.8 + 3.6) = 130`.
- Mullion holes: (0,0,50) and (0,0,120), `dir (1,0,0)`.
- Anchors: M12 at (10,245,10) and (100,245,10), `dir (0,0,−1)`, grip 10,
  length 110.

Auto slots (§9.1, default tolerances `src/core/model/ops.ts:100-116`):

- **Fin slot**: `T_vertical = 20` (slab level). The bracket is the fixed
  bracket, so `M = 0`.
  - `required = 40`, `L_req = ceil5(13 + 40) = 55`, so the uncapped extra is 42.
  - Caps: code long slot `2.5·12 − 13 = 17`; edge `2(75 − 35 − 19.5) = 41`.
  - Result: **17**.
- **Anchor slot** (top mount, `out`): `T = √(25² + 5²) = 25.50`.
  - `L_req = ceil5(15 + 51.0) = 70`, so the extra is **55**.
  - Edge cap: `2(75 − 22.5) = 105`, so it does not apply.

### 12.3 Fin plate

Set-up (§5.2):

- `Cs = (0,0,1500)`, `dIn = (1,0,0)`, `face = 50`.
- `ys = (0,1,0)`, `zs = (0,0,1)`.
- `H = max(60, 100) = 100`, `e = max(26, 25) = 26`.
- `ub = 50 + 100 − 26 = 124`, offsets ±25.

Frame:

- `P = Cs + ys·25 + dIn·50 − zs·50 = (50,25,1450)`.
- `z = dIn × zs = (0,−1,0)` points away from `n_out = ys`, so
  `origin = P + ys·10` = **(50,35,1450)**.
- Axes `x (1,0,0)`, `y (0,0,1)`, `z (0,−1,0)`.
- Corners at `z = 0`: (50,35,1450), (150,35,1450), (150,35,1550), (50,35,1550).
- Corners at `z = t`: the same at Y = 25 (on the transom's +y face).

Holes and bolts:

- Plate holes: `(74, 25)` and `(74, 75)`, `d 13`, `slot 0`. The transom has
  no joint at its far end, so this is not a movement end
  (`provisions.ts:522-523`).
- Hole centres: (124,30,1475) and (124,30,1525).
- Bolts: at (124,35,1475) and (124,35,1525), `dir (0,−1,0)`, `grip 10 + 50 = 60`,
  length `ceil10(79.4) = 80`.
- Transom holes: (124,0,1475) and (124,0,1525), `dir (0,1,0)`.
- DSTV plate: `AK` (0,0)…(100,100); `BO v 74 s 25 13` and `v 74 s 75 13`.

Assemblies: `M1 = {mullion, fin plate}`: welded, and the main is the member
(rank 0). `T1 = {transom}`. `BK1 = {back, fin}`: the main is the back plate
(`assemblyMain`).

### 12.4 Variants (same code, printed)

| Case | Result |
| --- | --- |
| Mullion drawn downwards (0,0,3500) → (0,0,0) | origin (0,0,3500), x (0,0,−1), **y (−1,0,0)**, z (0,1,0) |
| `alignZ −1, offsetY 20` at x = 500 | shift (20, 50), origin (520,50,0) |
| Transom `rotation 90` | y (0,0,1), z (0,−1,0) |
| Mullion leaning 50 mm over 3500 mm along X ("tilt") | x (0.014,0,1), **y (1,0,−0.014), z (0,1,0)** (vertical rule, §3.1; before the fix y (0,1,0), z (−1,0,0.014)) |
| Mullion leaning 50 mm over 3500 mm along Y | x (0,0.014,1), y (1,0,0), z (0,1,−0.014) |
| `startExt 30, endExt −20`, 1000 mm line (no connection) | origin x = −30, length 1010 |
| "ext at fin plate": the §12 transom with `startExt 30, endExt −20` | origin (60,0,1500), length 1420 = 1500 − 60 − 20: the start extension is ignored, warning "Start extension 30 mm is ignored: the Fin plate at that end sets the member end."; the free end keeps −20 |
| Transom at 30° in plan into the SHS 100 mullion (fin plate) | trim 67.74 = `face` 57.74 (= 50 / cos 30°) + gap 10; the bounding-box rule gave 78.30 |
| Edge-mount bracket at a stack joint (0…3500, 3500…7000) | upper member trim 25 (stack gap: `ceil5(1.89 + 20) = 25`); fin origin (60,−40,3325), 150 × 180; back plate origin (−25,150,3325), z (0,−1,0), so Y 140…150 (against the slab face Y = 150); anchor slot 25 along +X (edge cap `2(35 − 22.5)`); anchors at Y = 140, `dir (0,1,0)` |
| Fin plate `knife` | origin (50,5,1450), plate Y −5…5; bolt heads at Y = 25, grip 50, length 70; transom end slot `{end: start, face: z, x 0…95, offset 0, width 12}` (`t + 2`, `L − gap + 5`) |
| Custom "end plate + stiffener" at both ends of a 1000 mm transom ("custom both ends", starter template) | trims 62 / 62 (`face 50 + tp 12`); end plates X 50…62 and 938…950; bolts at x = 62 `dir −X` and x = 938 `dir +X`, grip 112, length 140; stiffener Y −4…4 at both ends (centred, §5.1; X 62…162 and 838…938, Z 1390…1450) |
| Slab bracket (top mount, §12.2) `finSide −1` | fin X −60…−50, back plate X −135…25 (centred on X = −55), fin bolts at X = −60 `dir (1,0,0)` |
| Slab bracket (top mount, §12.2) `edgeSetback 50` | back plate origin (−25,200,0); fin 150 × 390 |

---

## 13. Adding a connection type: checklist

1. **Type name**: add it to the `ConnectionType` union
   (`src/core/model/types.ts:122-157`).
2. **`ConnectionDef`** (`src/core/connections/common.ts:120-131`):
   - `type`, `label`, `description`, `needsMain`.
   - `params: ParamSpec[]` (`:101-109`), with kinds `number`, `select`, `bool`,
     `profile`, `bolt`, `text`, `template`. Use the `P.*` builders
     (`src/core/connections/kit.ts:145-154`).
   - Optional `paramsFor(c, p)` (per-connection specs, as in `custom.ts:72-77`).
3. **`trims(ctx)`**: it runs on **untrimmed** geometry, and the result is
   combined by maximum per member end (`src/core/derive/model.ts:244-275`).
   Return `{member, end: inward(g, N).end, amount}`.
4. **`build(ctx)`**: it returns a `ConnectionOut` (`common.ts:84-93`) built
   from trimmed geometry.
   - Get the joint with `jointOf`, `memberOf` or `bracketFrame`
     (`kit.ts:407-475`).
   - Plates: `addPlate({at, outward, x, y, outline})`; `y` is orthogonalised
     against `x` (§2.1), parallel axes throw.
   - Plate holes: `holeAt` from world points on the hole axis.
   - Member holes: `memberHole` (optional `slotDir`, `through: false`).
     Profile parts: `placeAngle`, `placeTee`, `sectionFrame` + `profileHole`.
   - A plate inserted into the supported member's end (knife, tongue, stem):
     `endSlot(out, g, end, pos, normal, t, engagement)` (`common.ts:232-248`).
   - Bolts: `addBolts({heads, dir, grip})`.
   - Welds: `weldedTo` / `out.welds` with refs `m:<id>` / `c:<cid>:<key>`.
   - Defaults: `edgeDist`, `pitchFor`, `longSlot`, `shortSlot` (`kit.ts:53-87`).
   - Report a misfit as a plain string in `out.warnings` (exceptions are also
     caught, `model.ts:288-292`).
5. **Register** it in `CONNECTIONS` (`src/core/connections/registry.ts:17-49`).
   Add it to `COLLINEAR_TYPES`, `ONE_PER_NODE` or `APPLY_END` if needed
   (`:52-76`).
6. **Catalogue**: add a `CATALOG` entry (`src/core/connections/catalog.ts:72`).
   Its keys must equal `CONNECTIONS` (`tests/connectionLibrary.test.ts:262-263`).
   Give a `joint` kind from `preview.ts:65-132` (or add one there), plus
   `previewProfiles` and `expectedWarnings`.
7. **Movement**: a type with a main member already counts as a joint at the
   far end of a member (`isMemberJoint`, `src/core/movement/provisions.ts:485-493`).
   If it should take thermal slots itself, add it to `SLOTTABLE_JOINTS`
   (`:483`), size the slot with `jointMovement`, and extend the report
   (`src/core/movement/report.ts:85-99`).
8. **Tests**: `npx vitest run tests/connectionLibrary.test.ts`.
   - It derives every type on its preview joint and expects no warnings and
     at least one part, bolt or weld (`:33-36`).
   - `runCodeChecks` (`src/core/codes/checks.ts:76`) must give no errors and
     no unexpected warnings for EC3 and AISC360, and no "assumed" bolts
     (`:37-47`).
   - Every preview profile (`:50-57`) and every select / bool variant
     (`:59-68`) must derive.
   - `applyConnection` must place the type (`:82-`).

Invariants to respect:

- **Holes and bolts**: every hole lies on a bolt axis within
  `d/2 + slot/2 + 1.5`, inside `[−5, grip + 5]` from the head
  (`checks.ts:181-198`).
  - `positions` are the head-side face of the grip, and `dir` points into the
    joint.
  - Linear-part holes must not be axial (`model.ts:169`).
  - Member slots may run in any direction in the drilled face (`slotDir`,
    carried as `slotAngle`, §6).
- **Part refs**: keep `PlateOut.key` / `ProfilePartOut.key` unique within a
  connection, because they form the part refs `c:<cid>:<key>`
  (`model.ts:350,377`).
  - Give one `assemblyMain` per loose assembly.
  - A weld to a missing ref is silently dropped (`model.ts:418`).
- **Purity**: do not mutate `ctx.p`. `build` must be deterministic, because
  marks are numbered from geometry signatures (`model.ts:578-588,651-664`).
- **Placement**: place from `N` / `Cs` / `face`, not from the physical member
  end. The connection governs the supported member's end at its node: user
  extensions there are ignored (§3.3), the end is wherever your `trims()` put
  it. Use `inward()` for direction and end.

---

## 14. Fixed caveats (formerly "Summary of caveats and inconsistencies")

The first version of this document listed fourteen inconsistencies. All are
fixed; each item says what changed and where. Tests: `tests/geometryFixes.test.ts`
(one block per item).

1. **One vertical threshold.** `isVerticalAxis` / `isHorizontalAxis`
   (`|d̂·Ẑ| > 0.995` / `< 0.005`, `src/core/model/geometry.ts:41-54`) are used
   by `axesFor` (`:69`), `memberDirection` (`src/core/model/ops.ts:428-431`,
   hence `autoConnect`, `endsFor`, auto-assign) and IFC role guessing
   (`src/core/io/ifcImport.ts:521`). Near-plumb members (up to 5.7°) use the
   `+Y` reference, so `ẑ ≈ +Y` continuous with the plumb case (§3.1, §12.4
   "tilt"). Plumb and horizontal members keep their exact axes. The `> 0.7`
   tests in the movement code classify facade directions and are unchanged
   (§1).
2. **Downward-drawn vertical members.** Comment and doc fixed
   (`geometry.ts:56-66`, §3.1): `ŷ = −X`, `ẑ = +Y` — `ŷ` flips with `x̂` as for
   horizontal members, the section depth stays `+Y`. Kept, so no existing
   member moves.
3. **Extensions vs connections.** A member end that a connection supports
   (secondary ending at its node) or trims is governed by it: `startExt` /
   `endExt` there are ignored with a warning (`appliedExt`,
   `src/core/derive/memberGeom.ts:38-45`; `src/core/derive/model.ts:209-231,266-275`).
   Free ends keep their extensions (§3.3).
4. **Custom side / top plates.** New option `place: 'face' | 'centre'`
   (`src/core/model/types.ts:201-208`, `src/core/connections/custom.ts:135-157`);
   absent = `'face'`, the original rule, so templates load unchanged. The
   starter stiffener is `v = 0, place: 'centre'` (Y −4…4); saved copies of the
   starter's old stiffener are centred by `migrateProject`
   (`src/state/storage.ts:66-86`). Editor: "Position" per plate (§5.1).
5. **Custom end frame.** New `CustomTemplate.frame: 'joint' | 'member'`
   (`src/core/model/types.ts:238-246`). `'joint'`: `V = W × U`, right-handed and
   joint-local at both ends (`src/core/connections/custom.ts:99-105`); new
   templates (starters, editor, assistant) use it. Templates saved before get
   `'member'` by migration and keep their geometry (§4.4).
6. **Slot directions of linear-part holes.** `PartHole.slotAngle`
   (`src/core/derive/model.ts:32-36,150-179`) from `WorldHole.slotDir`;
   honoured by DSTV (`src/core/fabrication/dstv.ts:225-236`), the hole table
   and machining text (`src/core/fabrication/machining.ts:44-48,79-103`), the
   part drawing (slot drawn turned, "@90°" in the table) and IFC (slot-shaped
   opening, `src/core/io/ifcExport.ts:457-472`). `memberHole` takes an optional
   `slotDir` (§6).
7. **Survey directions.** `bracketReference` returns the bracket's own axes
   `out = zN`, `vertical = up`, `along = ŷ` (`src/core/connections/slabBracket.ts:252-270`),
   the axes the offsets are applied along; deviation and adjustment agree on
   leaning mullions too (§9.2). Plumb mullions: unchanged.
8. **Slab bracket set-back and fin side.** Parameters `edgeSetback` (default
   20, unchanged geometry) and `finSide` (±1, default +1)
   (`src/core/connections/slabBracket.ts:40,49,105-106,127,149,197`), also in
   `bracketReference` (§5.3).
9. **Movement ends with library joints.** `isMemberJoint`
   (`src/core/movement/provisions.ts:485-493`) replaces the fixed type list:
   every connection with a main member (all `needsMain` types) counts, plus
   custom templates. A fin plate opposite a `doubleAngle` gets its thermal
   slot (§9.1).
10. **True face distance.** `faceDistance(main, Cs, dIn)`
    (`src/core/connections/common.ts:183-221`): the face of a rectangular
    section whose normal is closest to `dIn`, met along the secondary's axis;
    the cylinder for round sections; bounding-box support plane as fallback.
    Square framing unchanged (§4.3).
11. **`plateOn` orthonormal.** Gram–Schmidt on the in-plane axes, error on
    zero or parallel axes (`src/core/connections/common.ts:162-169`, §2.1).
12. **End slots.** `endSlot` / `WorldEndSlot` → `PartSlot`
    (`src/core/connections/common.ts:31-43,232-248`,
    `src/core/derive/model.ts:41-55,181-197`) for the knife fin plate, the
    gusset knife in tube braces, the tie-back tongue and a tee stem wider than
    the inside of a hollow secondary (§10 notes). Outputs: 3D
    (`slottedMemberGeometry`, `src/viewer/meshes.ts:239-304`, also in the
    connection preview), IFC rectangular opening (`ifcExport.ts:473-484`),
    DSTV contour notch (`dstv.ts:203-222,242-256`), machining step "End slot"
    (`machining.ts:56-64`), part drawing outline and "End slots" table
    (`partDrawing.ts:102-114,154-167`), numbering.
13. **Trim combination.** Kept as the maximum per end (coincident joints cut
    to the governing face), documented as intended; a warning flags one end
    cut back by different amounts (`src/core/derive/model.ts:244-265`, §3.3).
14. **IFC openings and DSTV through holes.** IFC hole openings span the walls
    the hole passes, from the section outline (`holeWalls`,
    `src/core/geometry/sectionWalls.ts:29-43`): every wall on the line for
    through holes, only its own wall for a one-wall hole (`WorldHole.through:
    false` → `PartHole.through`). DSTV: fabrication setting
    `dstvHollowThrough: 'one' | 'both'` (`src/core/model/types.ts:542-547`,
    default `'one'` = previous output; Fabrication panel and assistant
    `set_fabrication_settings`); one-wall holes go on the face of their wall
    (§11).
