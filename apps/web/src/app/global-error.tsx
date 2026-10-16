"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// Replaces the root layout, so it cannot rely on app CSS, fonts or components loading: inline styles only.
const BACKGROUND = "#0D1117";
const PANEL = "#161B22";
const FOREGROUND = "#F0F6FC";
const MUTED = "#9DA7B3";
const BRAND = "#C5A059";
const BORDER = "rgba(255, 255, 255, 0.12)";

const button = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: 40,
  padding: "0 20px",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 500,
  textDecoration: "none",
  cursor: "pointer",
} as const;

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <head>
        <title>Something went wrong · StackPrep</title>
        <meta name="robots" content="noindex" />
        <style>{`.ge-action:focus-visible{outline:2px solid ${BRAND};outline-offset:3px}`}</style>
      </head>
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
          background: BACKGROUND,
          color: FOREGROUND,
          fontFamily: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          colorScheme: "dark",
        }}
      >
        <main
          style={{
            width: "100%",
            maxWidth: 440,
            padding: 32,
            borderRadius: 14,
            border: `1px solid ${BORDER}`,
            background: PANEL,
            textAlign: "center",
          }}
        >
          <p
            style={{
              margin: 0,
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              fontWeight: 600,
              letterSpacing: "-0.01em",
            }}
          >
            <svg aria-hidden width={24} height={24} viewBox="0 0 24 24" fill="none">
              <rect x={3} y={14} width={18} height={3} rx={1} fill={BRAND} fillOpacity={0.35} />
              <rect x={5} y={10} width={14} height={3} rx={1} fill={BRAND} fillOpacity={0.55} />
              <rect x={7} y={6} width={10} height={3} rx={1} fill={BRAND} />
              <rect x={10.5} y={2} width={3} height={2.5} rx={1.25} fill={FOREGROUND} />
            </svg>
            StackPrep
          </p>
          <h1 style={{ margin: "24px 0 0", fontSize: 22, fontWeight: 600, letterSpacing: "-0.02em" }}>
            Something went wrong
          </h1>
          <p style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.6, color: MUTED }}>
            StackPrep hit an unexpected error and could not load this page. Reload to try again; if it keeps
            happening, come back in a few minutes.
          </p>
          <div style={{ marginTop: 24, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="ge-action"
              onClick={() => window.location.reload()}
              style={{ ...button, border: "none", background: BRAND, color: BACKGROUND }}
            >
              Reload
            </button>
            {/* A plain link forces a full document load, which a broken client router needs. */}
            {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
            <a href="/" className="ge-action" style={{ ...button, border: `1px solid ${BORDER}`, color: FOREGROUND }}>
              Home
            </a>
          </div>
          {error.digest ? (
            <p style={{ margin: "24px 0 0", fontSize: 12, color: MUTED }}>
              Error reference:{" "}
              <code style={{ fontFamily: "ui-monospace, SFMono-Regular, monospace", color: FOREGROUND }}>
                {error.digest}
              </code>
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
