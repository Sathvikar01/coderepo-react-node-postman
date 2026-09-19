export const LIMITS = {
    name: 80,
    description: 1000,
    rowsPerList: 100,
    rowKeyBytes: 256,
    rowValueBytes: 8 * 1024,
    urlBytes: 8 * 1024,
    queryBytes: 4 * 1024,
    requestHeaderBytes: 16 * 1024,
    requestBodyBytes: 64 * 1024,
    requestJsonBytes: 128 * 1024,
    variablesPerScope: 100,
    variableValueBytes: 8 * 1024,
    variableScopeBytes: 64 * 1024,
    requestsPerCollection: 100,
    foldersPerCollection: 20,
    collectionJsonBytes: 2 * 1024 * 1024,
    collectionBsonBytes: 4 * 1024 * 1024,
    collectionsPerProfile: 50,
    environmentsPerProfile: 20,
    openTabs: 10,
    jsonBodyCollection: 3 * 1024 * 1024,
    jsonBodyExecution: 1 * 1024 * 1024,
    jsonBodyEnvironment: 256 * 1024,
    jsonBodyDefault: 100 * 1024,
    responseHeaderBytes: 32 * 1024,
    responseHeaderPairs: 200,
    captureBytes: 1024 * 1024,
    decodedBytes: 1024 * 1024,
    historyBodyBytes: 256 * 1024,
    liveResultBytes: 8 * 1024 * 1024,
    historyRecordBytes: 1024 * 1024,
    historySearchMaxLength: 120,
    historyPageDefault: 50,
    historyPageMax: 100,
    jsonTreeNodes: 2000,
    jsonTreeParseBytes: 256 * 1024,
    rawPageLines: 500,
    markupDepth: 64,
    markupBytes: 256 * 1024,
    wsFrameBytes: 64 * 1024,
};

export const utf8Bytes = (value) => Buffer.byteLength(String(value ?? ""), "utf8");

export function assertWithin(actual, limit, code, scope, unit) {
    if (actual > limit) {
        return { limit, actual, unit, scope, code };
    }
    return null;
}
