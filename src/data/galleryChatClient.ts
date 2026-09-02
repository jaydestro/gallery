/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

export const MAX_GALLERY_CHAT_QUESTION_CHARACTERS = 1000;

const CHAT_RESPONSE_FIELDS = new Set(["answer", "citations"]);
const CITATION_FIELDS = new Set(["id", "title", "launchUrl"]);
const GENERIC_CHAT_ERROR = "The gallery assistant is temporarily unavailable. Please try again.";

export type GalleryChatCitation = {
  id: string;
  title: string;
  launchUrl: string;
};

export type GalleryChatResponse = {
  answer: string;
  citations: GalleryChatCitation[];
};

type GalleryChatFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type AskGalleryChatOptions = {
  apiBaseUrl: unknown;
  question: string;
  fetchImpl?: GalleryChatFetch;
  signal?: AbortSignal;
};

export class GalleryChatError extends Error {
  constructor(message = GENERIC_CHAT_ERROR) {
    super(message);
    this.name = "GalleryChatError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  const actualFields = Object.keys(value);
  return actualFields.length === fields.size && actualFields.every((field) => fields.has(field));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "";
  } catch {
    return false;
  }
}

function normalizeApiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GalleryChatError();
  }
  const normalized = value.trim().replace(/\/+$/, "");
  if (!isHttpUrl(normalized)) {
    throw new GalleryChatError();
  }
  const url = new URL(normalized);
  if (url.search || url.hash) {
    throw new GalleryChatError();
  }
  return normalized;
}

function normalizeQuestion(question: string): string {
  const normalized = question.trim();
  if (
    normalized.length === 0 ||
    normalized.length > MAX_GALLERY_CHAT_QUESTION_CHARACTERS
  ) {
    throw new GalleryChatError(
      `Enter a question between 1 and ${MAX_GALLERY_CHAT_QUESTION_CHARACTERS} characters.`,
    );
  }
  return normalized;
}

function validateCitation(value: unknown): GalleryChatCitation {
  if (
    !isRecord(value) ||
    !hasExactFields(value, CITATION_FIELDS) ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.title) ||
    !isHttpUrl(value.launchUrl)
  ) {
    throw new GalleryChatError();
  }
  return {
    id: value.id,
    title: value.title,
    launchUrl: value.launchUrl,
  };
}

function validateResponse(value: unknown): GalleryChatResponse {
  if (
    !isRecord(value) ||
    !hasExactFields(value, CHAT_RESPONSE_FIELDS) ||
    !isNonEmptyString(value.answer) ||
    !Array.isArray(value.citations)
  ) {
    throw new GalleryChatError();
  }
  const citations = value.citations.map(validateCitation);
  if (new Set(citations.map(({ id }) => id)).size !== citations.length) {
    throw new GalleryChatError();
  }
  return { answer: value.answer.trim(), citations };
}

async function readResponseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new GalleryChatError();
  }
}

export async function askGalleryChat({
  apiBaseUrl,
  question,
  fetchImpl = fetch,
  signal,
}: AskGalleryChatOptions): Promise<GalleryChatResponse> {
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const normalizedQuestion = normalizeQuestion(question);
  let response: Response;
  try {
    response = await fetchImpl(`${normalizedApiBaseUrl}/gallery/chat`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ question: normalizedQuestion }),
      cache: "no-store",
      credentials: "omit",
      signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new GalleryChatError();
  }
  if (!response.ok) {
    throw new GalleryChatError();
  }
  return validateResponse(await readResponseJson(response));
}