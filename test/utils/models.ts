export type V2RecordingLine = [kind: string, payload: unknown];

export type V2RecordedSetup = { directory: string; version: string };

export type V2SessionEventInput = { type: string; data: unknown };
