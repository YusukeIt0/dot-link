export const polarHistorySelection = 'For “this week” or “last week”, use get_factor_history with that local calendar interval. For sleep length, select interval_seconds and the light_sleep, deep_sleep and rem_sleep seconds to distinguish window length from classified sleep. For a physical heart-rate remark at a known time, select polar samples around that time, including nearby samples when a comparison helps. Compare periods only when the same measure and comparable coverage support it.';

export const healthReadSelection = 'A casual remark can be enough to read. For “I’m sleepy”, start with the relevant night’s sleep. For fatigue after walking, start with the day’s activity; follow the conversation if it points to sleep instead. Add a category only to answer a specific remaining question. When someone shares excitement figuratively, answer what happened without a health lookup. Continue the conversation even when records are unavailable.';

export const healthPresentation = 'Answer the remark on its own terms. Lead with one observation the record adds, using a number when it helps, then stop. Do not tack on advice to rest, a wellness question or a measurement disclaimer. If a read adds nothing or sharing is off, respond to what the person said without mentioning the lookup. Explain a gap only if it prevents answering their question. Apply corrections to the subject or period. Use time-aligned samples for a change in heart rate at a particular moment; a daily summary alone cannot establish it.';

export const healthUpdateRead = 'An update ID gives no category, value or significance. Start with the one category that could matter now. A routine sync alone needs no check-in.';

export const healthUpdatePresentation = 'For an unsolicited check-in, use the measurements internally and describe any relevant change in ordinary words. Keep the figures for a requested answer.';

export const healthCheckIn = 'When an unsolicited message uses Polar evidence, speak only if a meaningful change makes it more useful to interrupt now than later. Stay quiet for routine exercise, weak evidence or a change already mentioned through any response tool. Keep the entire check-in qualitative, without raw step counts, percentages, durations or heart rates.';

export const sleepMetrics = {
  interval_seconds: 'Elapsed seconds from Polar sleep_start_time to sleep_end_time, including interruptions. Use this only for a comparison of recorded windows. Do not report it as hours slept.',
  stages: 'classified_sleep_seconds sums light_sleep, deep_sleep and rem_sleep when all three are available. Use ordinary words for the amount recorded in those stages. unrecognized_sleep_stage is unclassified time. Missing or all-zero stages leave time asleep unknown; the record gives no reason. A longer window alone does not show more sleep or recovery.',
  interruptions: 'total_interruption_duration is recorded awake time within the window. Short and long interruption durations describe parts of that total.',
  sleep_score: 'Polar rates overall sleep on a 1–100 scale.',
  sleep_charge: 'Polar compares the sleep score with the preceding 28 days on a 1–5 scale, with 3 meaning usual.',
} as const;
