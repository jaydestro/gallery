/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { useCallback, useEffect, useState } from "react";
import type { User } from "./tags";
import { loadGalleryUsers } from "./galleryClient";
import { bundledCatalogUsers, TagList } from "./users";

type GalleryUsersState =
  | { status: "loading"; users: User[]; error: null }
  | { status: "success"; users: User[]; error: null }
  | { status: "error"; users: User[]; error: string };

export function useGalleryUsers({
  apiBaseUrl,
  useStaticCatalog,
}: {
  apiBaseUrl?: unknown;
  useStaticCatalog: boolean;
}) {
  const [requestVersion, setRequestVersion] = useState(0);
  const [state, setState] = useState<GalleryUsersState>({
    status: "loading",
    users: [],
    error: null,
  });

  const retry = useCallback(() => {
    setRequestVersion((version) => version + 1);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading", users: [], error: null });

    loadGalleryUsers({
      apiBaseUrl,
      useStaticCatalog,
      staticCatalog: bundledCatalogUsers,
      validTags: TagList,
      signal: controller.signal,
    }).then(
      (users) => {
        if (!controller.signal.aborted) {
          setState({ status: "success", users, error: null });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setState({
            status: "error",
            users: [],
            error: error instanceof Error ? error.message : "The gallery data could not be loaded.",
          });
        }
      },
    );

    return () => controller.abort();
  }, [apiBaseUrl, requestVersion, useStaticCatalog]);

  return { ...state, retry };
}