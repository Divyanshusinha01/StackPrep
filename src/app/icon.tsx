import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const BRAND = "#C5A059";
const NAVY_MARK = "#0D1117";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 7,
          background: BRAND,
          color: NAVY_MARK,
          fontSize: 15,
          fontWeight: 700,
          letterSpacing: -1,
        }}
      >
        {">_"}
      </div>
    ),
    size,
  );
}
