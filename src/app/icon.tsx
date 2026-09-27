import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

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
          background: "#a99cf5",
          color: "#1a1530",
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
