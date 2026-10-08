import { notFound } from "next/navigation";
import { getInterview } from "@/lib/api";
import { getUser } from "@/lib/auth";

/**
 * Checks the interview exists before the page's loading boundary starts streaming, so a missing or
 * deleted interview answers 404 rather than 200. Signed-out visitors fall through to the page's login redirect.
 */
export default async function InterviewLayout({ children, params }: LayoutProps<"/interviews/[id]">) {
  const { id } = await params;
  if ((await getUser()) && !(await getInterview(id))) {
    notFound();
  }
  return children;
}
