export interface Point {
  x: number;
  y: number;
  z: number;
  g: number;
  name?: string;
  region?: string;
  faction?: string;
  sub?: string;
  icon?: number;
  near?: string;
  area_km2?: number;
  c?: number;
  n?: number;
  to?: string;
  from?: string;
  pvp?: boolean;
  dest?: string;
}

export interface Rule {
  max?: number | null;
  life?: number | null;
  cd?: number | null;
  every?: number;
  grow?: number;
  near?: boolean;
}

export interface Layer {
  id: string;
  name: string;
  group: string;
  rule: Rule | null;
  icon: number;
  size: number;
  points: Point[];
  hidden?: boolean;
}

export interface Resource {
  id: string;
  name: string;
  game: string | null;
  aliases: string[];
  icon: number;
  color: string;
  spots: Point[];
  nodes: [number, number];
  overlay?: string;
  group?: string;
  k?: number;
}

export interface Icons {
  file: string;
  cell: number;
  cols: number;
  rows: number;
  pin: number;
  player: number;
}

export interface DDNodes {
  scale: number;
  Minerals: string;
  Scrap: string;
  chance: Record<string, string>;
  fixed: Record<string, string>;
}

export interface MapData {
  world?: 'dd' | 'om';
  layout?: number;
  layouts?: number[];
  live?: number;
  size_m: number;
  tiles: { levels: number; tile: number; ext: string; bundle?: string };
  terrain: { file: string; shape: [number, number]; step_m: number; tiles?: number; grid?: number[]; off?: number[] };
  nodes?: DDNodes;
  index?: Record<string, Record<string, string[]>>;
  labels?: { text: string; x: number; y: number; big?: boolean }[];
  icons: Icons;
  resources: Resource[];
  tracker: { id: string; icon: number; name: string }[];
  masks: string[];
  layers: Layer[];
}

export interface Pick { layer: string; index: number }
