import { z } from "zod";

export const profileResponseSchema = z.object({
  id: z.uuid(),
  github_login: z.string().nullable(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
});

export type ProfileResponse = z.infer<typeof profileResponseSchema>;
