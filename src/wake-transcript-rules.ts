/** Text-only rules, independent of UI language and acoustic wake detection.
 * New scripts need recorded ASR evidence and negative ordinary-word fixtures.
 * Only default Dot aliases belong here; custom names remain literal ASCII.
 */
export const defaultWakeTranscriptRules: readonly {
  id: string;
  prefix: RegExp;
  cueOnly?: RegExp;
}[] = [
  {
    id: 'en',
    prefix: /^hey[\s,、，。・･.!！?？:：-]*dot\b[\s,、，。・･.!！?？:：-]*/iu,
    cueOnly: /^dot[\s.!！?？。]*$/iu,
  },
  {
    id: 'ja',
    prefix: /^ヘイ[\s,、，。・･.!！?？:：-]*ドット[\s,、，。・･.!！?？:：-]*/iu,
    cueOnly: /^ドット[\s.!！?？。]*$/iu,
  },
  {
    id: 'ko',
    // Observed local-ASR form: 헤이 닷. Require boundaries to preserve 닷컴.
    // No cue-only alias: the recorded isolated cue was ambiguous.
    prefix: /^헤이[\s,、，。・･.!！?？:：-]+닷(?=$|[\s,、，。・･.!！?？:：-])[\s,、，。・･.!！?？:：-]*/u,
  },
];
