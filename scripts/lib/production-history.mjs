/** Build-time fence: fictional movement belongs only to isolated test tooling. */
export function assertProductionHistoryAsset(path, text) {
  if (/(?:^|\/)history\/fixtures\.ts$/.test(path) ||
      /history-(?:simulate|finish-test|scenario)|even\.history_(?:test|start_test|finish_test)|Fixture (?:Garden|East Road|North Road)/.test(text)) {
    throw new Error(`History test material found in application asset: ${path}`);
  }
}
