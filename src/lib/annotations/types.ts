// The annotation vendor's per-clip JSON, as the "Egocentric Annotation Schema" defines it.

export interface Rle {
  size: [number, number];
  counts: string;
}

export interface Track {
  id: number;
  type: "left_hand" | "right_hand" | "other_hand" | "object" | string;
  category?: string;
  parent_id?: number | null;
  group?: boolean;
}

export interface Label {
  track_id: number;
  visibility?: "visible" | "partial" | "occluded" | string;
  box?: [number, number, number, number] | null;
  mask?: Rle | null;
  contact?: string | null;
  contact_id?: number | null;
  keypoints_3d?: unknown;
  uncertain?: boolean;
  note?: string;
}

export interface Action {
  hand: "left" | "right" | string;
  start_frame: number;
  end_frame: number;
  label: string;
  verb?: string | null;
  object_ids?: number[];
  target_id?: number | null;
  bimanual_id?: number | null;
  repetitions?: number;
}

export interface ObjectState {
  track_id: number;
  layer: "hold" | "motion" | "state" | string;
  value: string;
  start_frame: number;
  end_frame: number;
}

export interface PrivacyTrack {
  id: number;
  type: string;
  start_frame: number;
  end_frame: number;
  boxes: { frame: number; box: [number, number, number, number] }[];
}

export interface Annotation {
  clip_id: string;
  fps: number;
  width: number;
  height: number;
  annotated_every_n_frames: number;
  tracks: Track[];
  frames: { frame: number; labels: Label[] }[];
  actions: Action[];
  object_states: ObjectState[];
  privacy: PrivacyTrack[];
  transcript?: { start_frame: number; end_frame: number; text: string }[];
}

export type Severity = "major" | "minor" | "info";

export interface Issue {
  severity: Severity;
  layer: string;
  msg: string;
  frame: number | null;
  end: number | null;
}

export interface TrackStats {
  labels: number;
  visible: number;
  partial: number;
  occluded: number;
  boxMaskIou: number | null;
}

export interface QaReport {
  totalFrames: number;
  totalFramesFrom: "video" | "annotation";
  annotatedFrames: number;
  counts: Record<Severity, number>;
  issues: Issue[];
  trackStats: Record<number, TrackStats>;
}

/** One clip as loaded on the page: its JSON and, if supplied, its blurred video. */
export interface LoadedClip {
  id: string;
  annotation: Annotation;
  videoUrl: string | null;
  videoName: string | null;
  videoFrames: number | null;
  videoFps: number | null;
  qa: QaReport;
}
