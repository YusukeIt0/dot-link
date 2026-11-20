export const locationHistoryFields = ['position', 'motion', 'clock', 'geography'] as const;
export type LocationHistoryField = typeof locationHistoryFields[number];

export const locationHistoryFieldDescriptions: Record<LocationHistoryField, string> = {
  position: 'Phone fix latitude and longitude in degrees, and horizontal accuracy in metres.',
  motion: 'Phone-reported speed in metres per second and heading in degrees. A missing reading is null.',
  clock: 'Mac received_at and the timezone and utc_offset_minutes reported during phone upload. A missing value is null.',
  geography: 'Historical map references attached to this fix, with source, release, attribution, relation, distance and coverage limitations.',
};
