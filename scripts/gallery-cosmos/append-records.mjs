import {
  CosmosDomainError,
  MAX_COSMOS_ITEM_BYTES,
  cosmosStatus,
  responseEtag,
} from "./container-operations.mjs";
import {
  createPipelineReceipt,
  createReviewCandidate,
  createReviewDecision,
} from "./documents.mjs";

export { MAX_COSMOS_ITEM_BYTES };

async function appendImmutable(container, document) {
  if (typeof container?.createItem !== "function") {
    throw new TypeError("container.createItem must be a function.");
  }
  const itemBytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (itemBytes > MAX_COSMOS_ITEM_BYTES) {
    throw new CosmosDomainError(
      "COSMOS_ITEM_TOO_LARGE",
      `${document.type} ${document.id} exceeds the ${MAX_COSMOS_ITEM_BYTES}-byte operational ceiling.`,
      { id: document.id, itemBytes, type: document.type },
    );
  }
  try {
    const response = await container.createItem(document, {
      partitionKey: document.runKey,
      ifNoneMatch: "*",
    });
    return Object.freeze({
      document,
      etag: responseEtag(response),
    });
  } catch (error) {
    if (Number(cosmosStatus(error)) === 409) {
      throw new CosmosDomainError(
        "IMMUTABLE_RECORD_CONFLICT",
        `${document.type} ${document.id} already exists in run ${document.runKey}.`,
        { id: document.id, runKey: document.runKey, type: document.type },
      );
    }
    throw error;
  }
}

export function appendReviewCandidate({ candidateContainer, ...input }) {
  return appendImmutable(candidateContainer, createReviewCandidate(input));
}

export function appendReviewDecision({ decisionContainer, ...input }) {
  return appendImmutable(decisionContainer, createReviewDecision(input));
}

export function appendPipelineReceipt({ receiptContainer, ...input }) {
  return appendImmutable(receiptContainer, createPipelineReceipt(input));
}