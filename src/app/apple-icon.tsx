import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const BRAND = "#C5A059";
const BACKGROUND = "#0D1117";
const NAVY_MARK = "#0D1117";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BACKGROUND,
        }}
      >
        <div
          style={{
            width: 132,
            height: 132,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 30,
            background: BRAND,
            color: NAVY_MARK,
            fontSize: 64,
            fontWeight: 700,
            letterSpacing: -4,
          }}
        >
          {">_"}
        </div>
      </div>
    ),
    size,
  );
}
