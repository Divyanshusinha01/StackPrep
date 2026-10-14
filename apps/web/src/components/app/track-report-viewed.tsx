"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";

/** Records a content-free `report_viewed` event once per mount of a ready report. */
export function TrackReportViewed() {
  useEffect(() => {
    track("report_viewed", {});
  }, []);
  return null;
}
