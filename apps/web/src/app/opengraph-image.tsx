import { ImageResponse } from "next/og";

export const alt = "StackPrep · Turn your codebase into an interview";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BRAND = "#C5A059";
const BACKGROUND = "#0D1117";
const FOREGROUND = "#F0F6FC";
const NAVY_MARK = "#0D1117";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: BACKGROUND,
          backgroundImage:
            "radial-gradient(ellipse 70% 60% at 50% 0%, rgba(197, 160, 89, 0.32), transparent 70%)",
          color: FOREGROUND,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 30, fontWeight: 600 }}>
          <div
            style={{
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 10,
              background: BRAND,
              color: NAVY_MARK,
              fontSize: 20,
              fontWeight: 700,
            }}
          >
            {">_"}
          </div>
          StackPrep
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              fontSize: 76,
              fontWeight: 700,
              letterSpacing: -3,
              lineHeight: 1.05,
            }}
          >
            <span style={{ marginRight: 20 }}>Turn your codebase into</span>
            <span
              style={{
                backgroundImage: `linear-gradient(100deg, ${FOREGROUND} 5%, ${BRAND} 95%)`,
                backgroundClip: "text",
                color: "transparent",
              }}
            >
              an interview.
            </span>
          </div>
          <div style={{ marginTop: 28, fontSize: 30, color: "#8B949E", maxWidth: 900, lineHeight: 1.4 }}>
            Get interviewed by an AI that has read your code, then get a report built on evidence.
          </div>
        </div>

        <div style={{ display: "flex", gap: 14 }}>
          {["src/api/middleware.ts", "src/auth/session.ts", "src/lib/queue.ts"].map((path) => (
            <div
              key={path}
              style={{
                display: "flex",
                padding: "8px 16px",
                borderRadius: 10,
                border: "1px solid rgba(197, 160, 89, 0.35)",
                background: "rgba(197, 160, 89, 0.12)",
                color: BRAND,
                fontSize: 22,
              }}
            >
              {path}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
