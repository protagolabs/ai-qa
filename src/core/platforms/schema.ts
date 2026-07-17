import { z } from "zod";

export const platformSchema = z.enum([
  "web",
  "ios-simulator",
  "android-emulator",
]);
export type Platform = z.infer<typeof platformSchema>;

export const controllerSchema = z.enum([
  "chrome-devtools-mcp",
  "pepper",
  "appium",
]);
export type Controller = z.infer<typeof controllerSchema>;
