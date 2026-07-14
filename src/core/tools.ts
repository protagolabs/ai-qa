import { z } from "zod";

export const WEB_CONTROLLER = "chrome-devtools-mcp" as const;
export const webControllerSchema = z.literal(WEB_CONTROLLER);
export type WebController = z.infer<typeof webControllerSchema>;
