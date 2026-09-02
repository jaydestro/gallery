function key(id, partitionKey) {
  return `${partitionKey}\0${id}`;
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function parameterMap(parameters = []) {
  return new Map(parameters.map(({ name, value }) => [name, value]));
}

export class InMemoryContainer {
  #documents = new Map();
  #etagSequence = 0;
  #failures = [];

  constructor(documents = []) {
    for (const document of documents) this.seed(document);
    this.calls = [];
  }

  seed(document, partitionKey = document.catalogPartition ?? document.runKey) {
    const resource = structuredClone(document);
    resource._etag ??= this.#nextEtag();
    this.#documents.set(key(resource.id, partitionKey), resource);
    return structuredClone(resource);
  }

  failNext(method, statusCode) {
    this.#failures.push({ method, statusCode });
  }

  snapshot() {
    return [...this.#documents.values()].map((document) => structuredClone(document));
  }

  #nextEtag() {
    this.#etagSequence += 1;
    return `\"etag-${this.#etagSequence}\"`;
  }

  #maybeFail(method) {
    const index = this.#failures.findIndex((failure) => failure.method === method);
    if (index === -1) return;
    const [failure] = this.#failures.splice(index, 1);
    throw httpError(failure.statusCode, `${method} failed with ${failure.statusCode}.`);
  }

  async createItem(document, options = {}) {
    this.calls.push({ method: "createItem", document: structuredClone(document), options: structuredClone(options) });
    this.#maybeFail("createItem");
    if (options.ifNoneMatch !== "*") throw new Error("Fake requires createItem If-None-Match: *.");
    const documentKey = key(document.id, options.partitionKey);
    if (this.#documents.has(documentKey)) throw httpError(409, "Conflict");
    const resource = { ...structuredClone(document), _etag: this.#nextEtag() };
    this.#documents.set(documentKey, resource);
    return { resource: structuredClone(resource), etag: resource._etag, statusCode: 201 };
  }

  async readItem(id, options = {}) {
    this.calls.push({ method: "readItem", id, options: structuredClone(options) });
    this.#maybeFail("readItem");
    const resource = this.#documents.get(key(id, options.partitionKey));
    if (!resource) throw httpError(404, "Not found");
    return { resource: structuredClone(resource), etag: resource._etag, statusCode: 200 };
  }

  async replaceItem(id, document, options = {}) {
    this.calls.push({ method: "replaceItem", id, document: structuredClone(document), options: structuredClone(options) });
    this.#maybeFail("replaceItem");
    const documentKey = key(id, options.partitionKey);
    const existing = this.#documents.get(documentKey);
    if (!existing) throw httpError(404, "Not found");
    if (!options.ifMatch || options.ifMatch !== existing._etag) throw httpError(412, "Precondition failed");
    const resource = { ...structuredClone(document), _etag: this.#nextEtag() };
    this.#documents.set(documentKey, resource);
    return { resource: structuredClone(resource), etag: resource._etag, statusCode: 200 };
  }

  async queryItems(request) {
    this.calls.push({ method: "queryItems", request: structuredClone(request) });
    this.#maybeFail("queryItems");
    const parameters = parameterMap(request.parameters);
    let resources = [...this.#documents.values()].filter((document) => (
      document.catalogPartition === request.partitionKey &&
      (!parameters.has("@catalogPartition") || document.catalogPartition === parameters.get("@catalogPartition")) &&
      (!parameters.has("@type") || document.type === parameters.get("@type")) &&
      (!parameters.has("@snapshotId") || document.snapshotId === parameters.get("@snapshotId")) &&
      (!parameters.has("@publicationStatus") || document.publicationStatus === parameters.get("@publicationStatus"))
    ));
    if (parameters.has("@activeStatus") || parameters.has("@reviewStatus")) {
      const allowed = new Set([parameters.get("@activeStatus"), parameters.get("@reviewStatus")]);
      resources = resources.filter((document) => allowed.has(document.lifecycleStatus));
    }
    resources.sort((left, right) => left.displayOrder - right.displayOrder ||
      String(left.catalogId ?? left.id).localeCompare(String(right.catalogId ?? right.id)));
    const offset = request.continuationToken ? Number(request.continuationToken) : 0;
    const size = request.maxItemCount ?? resources.length;
    const page = resources.slice(offset, offset + size).map((document) => structuredClone(document));
    const nextOffset = offset + page.length;
    return {
      resources: page,
      continuationToken: nextOffset < resources.length ? String(nextOffset) : null,
    };
  }
}