import { z } from "zod";

export const deploymentSchema = z.object({
  deployment: z.object({
    port: z.number(),
    log_file: z.string(),
  }),
});

export type DeploymentConfig = z.infer<typeof deploymentSchema>;
