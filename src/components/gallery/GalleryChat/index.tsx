/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import React, { useEffect, useRef, useState } from "react";
import {
  Button,
  Field,
  Spinner,
  Text,
  Textarea,
  Tooltip,
} from "@fluentui/react-components";
import {
  Chat24Regular,
  Dismiss20Regular,
  Send20Regular,
} from "@fluentui/react-icons";
import {
  askGalleryChat,
  type GalleryChatResponse,
  MAX_GALLERY_CHAT_QUESTION_CHARACTERS,
} from "@site/src/data/galleryChatClient";
import styles from "./styles.module.css";

type ChatStatus = "idle" | "loading" | "success" | "error";

const PANEL_ID = "gallery-chat-panel";
const PANEL_TITLE_ID = "gallery-chat-title";
const GENERIC_ERROR_MESSAGE = "We couldn't get an answer. Please try again.";

export default function GalleryChat({ apiBaseUrl }: { apiBaseUrl: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [response, setResponse] = useState<GalleryChatResponse | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const restoreLauncherFocusRef = useRef(false);

  useEffect(() => {
    if (isOpen) {
      questionInputRef.current?.focus();
    } else if (restoreLauncherFocusRef.current) {
      launcherRef.current?.focus();
      restoreLauncherFocusRef.current = false;
    }
  }, [isOpen]);

  useEffect(() => {
    return () => requestControllerRef.current?.abort();
  }, []);

  const openPanel = () => {
    restoreLauncherFocusRef.current = false;
    setIsOpen(true);
  };

  const closePanel = () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setStatus((currentStatus) => currentStatus === "loading" ? "idle" : currentStatus);
    restoreLauncherFocusRef.current = true;
    setIsOpen(false);
  };

  const clear = () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setQuestion("");
    setResponse(null);
    setStatus("idle");
    questionInputRef.current?.focus();
  };

  const submitQuestion = async () => {
    if (requestControllerRef.current || question.trim().length === 0) return;

    const controller = new AbortController();
    requestControllerRef.current = controller;
    setResponse(null);
    setStatus("loading");

    try {
      const nextResponse = await askGalleryChat({
        apiBaseUrl,
        question,
        signal: controller.signal,
      });
      if (requestControllerRef.current === controller) {
        setResponse(nextResponse);
        setStatus("success");
      }
    } catch (error) {
      if (
        requestControllerRef.current === controller &&
        !(error instanceof Error && error.name === "AbortError")
      ) {
        setStatus("error");
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
      }
    }
  };

  if (!isOpen) {
    return (
      <Tooltip withArrow content="Ask the Gallery" relationship="label">
        <Button
          ref={launcherRef}
          className={styles.launcher}
          appearance="primary"
          shape="circular"
          size="large"
          icon={<Chat24Regular />}
          aria-label="Open Ask the Gallery"
          aria-haspopup="dialog"
          aria-controls={PANEL_ID}
          aria-expanded={false}
          onClick={openPanel}
        />
      </Tooltip>
    );
  }

  return (
    <section
      id={PANEL_ID}
      className={styles.panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby={PANEL_TITLE_ID}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          closePanel();
        }
      }}
    >
      <header className={styles.header}>
        <Text as="h2" id={PANEL_TITLE_ID} size={500} weight="semibold" className={styles.title}>
          Ask the Gallery
        </Text>
        <Tooltip withArrow content="Close" relationship="label">
          <Button
            appearance="subtle"
            size="small"
            icon={<Dismiss20Regular />}
            aria-label="Close Ask the Gallery"
            onClick={closePanel}
          />
        </Tooltip>
      </header>

      <div
        className={styles.answerRegion}
        aria-live="polite"
        aria-busy={status === "loading"}
        aria-label="Gallery assistant response"
      >
        {status === "loading" ? (
          <div className={styles.centeredState}>
            <Spinner size="small" label="Finding gallery resources..." />
          </div>
        ) : status === "error" ? (
          <div className={styles.errorState} role="alert">
            <Text weight="semibold">Something went wrong</Text>
            <Text>{GENERIC_ERROR_MESSAGE}</Text>
            <Button appearance="secondary" size="small" onClick={submitQuestion}>
              Retry
            </Button>
          </div>
        ) : status === "success" && response ? (
          <div className={styles.response}>
            <Text as="p" className={styles.answer}>{response.answer}</Text>
            {response.citations.length > 0 ? (
              <div className={styles.citations}>
                <Text as="h3" size={300} weight="semibold" className={styles.citationsTitle}>
                  Sources
                </Text>
                <ul className={styles.citationList}>
                  {response.citations.map((citation) => (
                    <li key={citation.id}>
                      <a
                        className={styles.citationLink}
                        href={citation.launchUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {citation.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <form
        className={styles.questionForm}
        onSubmit={(event) => {
          event.preventDefault();
          void submitQuestion();
        }}
      >
        <Field
          label="Question"
          hint={`${question.length} of ${MAX_GALLERY_CHAT_QUESTION_CHARACTERS} characters`}
        >
          <Textarea
            ref={questionInputRef}
            value={question}
            maxLength={MAX_GALLERY_CHAT_QUESTION_CHARACTERS}
            rows={3}
            resize="none"
            disabled={status === "loading"}
            onChange={(_event, data) => setQuestion(data.value)}
          />
        </Field>
        <div className={styles.formActions}>
          {question.length > 0 || response || status === "error" ? (
            <Button type="button" appearance="subtle" onClick={clear}>
              Clear
            </Button>
          ) : null}
          <Button
            type="submit"
            appearance="primary"
            icon={<Send20Regular />}
            disabled={status === "loading" || question.trim().length === 0}
          >
            Send
          </Button>
        </div>
      </form>
    </section>
  );
}