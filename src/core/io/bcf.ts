/**
 * BCF 2.1 export of clash issues (.bcfzip): `bcf.version`, `project.bcfp` and
 * one folder per topic with `markup.bcf` and `viewpoint.bcfv` (perspective
 * camera aimed at the clash, components = IFC GlobalIds of the steel parts as
 * written by exportIfc, and of the reference elements as read from their file).
 * BCF coordinates are metres in the IFC world (our mm / 1000).
 */
import type { ClashIssue, Project, Vec3 } from '../model/types';
import { zip } from './zip';
import { ifcGuidFrom, partGuid, uuidFrom } from './guid';

export interface BcfOptions {
  author?: string;
  /** Which issues to write (default: open ones). */
  statuses?: ClashIssue['status'][];
  /** PNG snapshot per issue id. */
  snapshots?: Map<string, Uint8Array>;
  /** Camera distance from the clash point, mm. */
  cameraDistance?: number;
  /** Name of the steel IFC file the components refer to. */
  ifcFileName?: string;
}

export const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface BcfComponent {
  ifcGuid: string;
  /** Our part ref or reference element key. */
  toolId: string;
  steel: boolean;
}

/** IFC components of an issue: steel part GUIDs (deterministic, see exportIfc) and reference element GUIDs. */
export function issueComponents(p: Project, issue: ClashIssue): BcfComponent[] {
  const out: BcfComponent[] = [];
  for (const ref of [issue.a, issue.b]) {
    if (ref.startsWith('ifc:')) {
      const guid = ref.split(':').slice(2).join(':');
      if (guid && !guid.startsWith('#')) out.push({ ifcGuid: guid, toolId: ref, steel: false });
    } else out.push({ ifcGuid: partGuid(p.id, ref), toolId: ref, steel: true });
  }
  return out;
}

const STATUS: Record<ClashIssue['status'], string> = { open: 'Open', resolved: 'Resolved', ignored: 'Closed' };

const m = (v: number) => (Math.round(v * 1e3) / 1e6).toFixed(6);
const xyz = (tag: string, v: Vec3) => `<${tag}><X>${m(v.x)}</X><Y>${m(v.y)}</Y><Z>${m(v.z)}</Z></${tag}>`;
const dirXyz = (tag: string, v: Vec3) => `<${tag}><X>${v.x.toFixed(6)}</X><Y>${v.y.toFixed(6)}</Y><Z>${v.z.toFixed(6)}</Z></${tag}>`;

/** Perspective camera looking at the clash from the south-west, above. */
export function clashCamera(pos: Vec3, distance = 2500): { eye: Vec3; dir: Vec3; up: Vec3 } {
  const off = { x: -0.55, y: -0.7, z: 0.45 };
  const l = Math.hypot(off.x, off.y, off.z);
  const eye = { x: pos.x + (off.x / l) * distance, y: pos.y + (off.y / l) * distance, z: pos.z + (off.z / l) * distance };
  const dir = { x: -off.x / l, y: -off.y / l, z: -off.z / l };
  const k = dir.z;
  const up0 = { x: -k * dir.x, y: -k * dir.y, z: 1 - k * dir.z };
  const ul = Math.hypot(up0.x, up0.y, up0.z);
  return { eye, dir, up: { x: up0.x / ul, y: up0.y / ul, z: up0.z / ul } };
}

export function viewpointXml(p: Project, issue: ClashIssue, vpGuid: string, distance?: number): string {
  const cam = clashCamera(issue.pos, distance);
  const comps = issueComponents(p, issue);
  const comp = (c: BcfComponent) =>
    `      <Component IfcGuid="${xmlEscape(c.ifcGuid)}">\n        <OriginatingSystem>${c.steel ? 'FacadeSteel' : 'Reference model'}</OriginatingSystem>\n        <AuthoringToolId>${xmlEscape(c.toolId)}</AuthoringToolId>\n      </Component>`;
  const steel = comps.filter((c) => c.steel);
  const ref = comps.filter((c) => !c.steel);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<VisualizationInfo Guid="${vpGuid}" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`,
    '  <Components>',
    '    <Selection>',
    ...comps.map(comp),
    '    </Selection>',
    '    <Visibility DefaultVisibility="true" />',
    '    <Coloring>',
    ...(steel.length ? ['      <Color Color="FFFF3B30">', ...steel.map((c) => `        <Component IfcGuid="${xmlEscape(c.ifcGuid)}" />`), '      </Color>'] : []),
    ...(ref.length ? ['      <Color Color="FF2F80ED">', ...ref.map((c) => `        <Component IfcGuid="${xmlEscape(c.ifcGuid)}" />`), '      </Color>'] : []),
    '    </Coloring>',
    '  </Components>',
    '  <PerspectiveCamera>',
    `    ${xyz('CameraViewPoint', cam.eye)}`,
    `    ${dirXyz('CameraDirection', cam.dir)}`,
    `    ${dirXyz('CameraUpVector', cam.up)}`,
    '    <FieldOfView>60</FieldOfView>',
    '  </PerspectiveCamera>',
    '</VisualizationInfo>',
    '',
  ].join('\n');
}

export function markupXml(p: Project, issue: ClashIssue, vpGuid: string, o: BcfOptions & { snapshot?: boolean } = {}): string {
  const author = xmlEscape(o.author || p.info.designer || 'FacadeSteel');
  const date = issue.created || new Date().toISOString();
  const kind = issue.kind === 'hard' ? 'Hard clash' : 'Clearance';
  const desc = `${kind}: ${issue.title}. ${issue.kind === 'hard' ? 'Penetration' : 'Gap'} ${issue.distance} mm at X ${Math.round(issue.pos.x)}, Y ${Math.round(issue.pos.y)}, Z ${Math.round(issue.pos.z)} mm. Objects: ${issue.a} / ${issue.b}.`;
  const file = o.ifcFileName ?? `${(p.info.name || 'facade').replace(/[^\w.-]+/g, '_')}.ifc`;
  const commentGuid = uuidFrom(`${issue.guid}|comment`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Markup xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '  <Header>',
    `    <File IfcProject="${ifcGuidFrom(`${p.id}|project`)}" isExternal="true">`,
    `      <Filename>${xmlEscape(file)}</Filename>`,
    `      <Date>${xmlEscape(date)}</Date>`,
    '    </File>',
    '  </Header>',
    `  <Topic Guid="${issue.guid}" TopicType="Clash" TopicStatus="${STATUS[issue.status]}">`,
    `    <Title>${xmlEscape(issue.title)}</Title>`,
    `    <Labels>${kind}</Labels>`,
    `    <CreationDate>${xmlEscape(date)}</CreationDate>`,
    `    <CreationAuthor>${author}</CreationAuthor>`,
    `    <Description>${xmlEscape(desc)}</Description>`,
    '  </Topic>',
    ...(issue.comment
      ? [
          `  <Comment Guid="${commentGuid}">`,
          `    <Date>${xmlEscape(date)}</Date>`,
          `    <Author>${author}</Author>`,
          `    <Comment>${xmlEscape(issue.comment)}</Comment>`,
          `    <Viewpoint Guid="${vpGuid}" />`,
          '  </Comment>',
        ]
      : []),
    `  <Viewpoints Guid="${vpGuid}">`,
    '    <Viewpoint>viewpoint.bcfv</Viewpoint>',
    ...(o.snapshot ? ['    <Snapshot>snapshot.png</Snapshot>'] : []),
    '  </Viewpoints>',
    '</Markup>',
    '',
  ].join('\n');
}

/** Build the .bcfzip bytes. */
export function exportBcf(p: Project, issues: ClashIssue[], o: BcfOptions = {}): Uint8Array {
  const statuses = new Set(o.statuses ?? ['open']);
  const files: { name: string; data: Uint8Array | string }[] = [
    {
      name: 'bcf.version',
      data: '<?xml version="1.0" encoding="UTF-8"?>\n<Version VersionId="2.1" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <DetailedVersion>2.1</DetailedVersion>\n</Version>\n',
    },
    {
      name: 'project.bcfp',
      data: `<?xml version="1.0" encoding="UTF-8"?>\n<ProjectExtension xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n  <Project ProjectId="${uuidFrom(`${p.id}|bcf-project`)}">\n    <Name>${xmlEscape(p.info.name || 'FacadeSteel project')}</Name>\n  </Project>\n  <ExtensionSchema></ExtensionSchema>\n</ProjectExtension>\n`,
    },
  ];
  for (const issue of issues) {
    if (!statuses.has(issue.status)) continue;
    const vp = uuidFrom(`${issue.guid}|viewpoint`);
    const snap = o.snapshots?.get(issue.id);
    files.push({ name: `${issue.guid}/markup.bcf`, data: markupXml(p, issue, vp, { ...o, snapshot: !!snap }) });
    files.push({ name: `${issue.guid}/viewpoint.bcfv`, data: viewpointXml(p, issue, vp, o.cameraDistance) });
    if (snap) files.push({ name: `${issue.guid}/snapshot.png`, data: snap });
  }
  return zip(files);
}
