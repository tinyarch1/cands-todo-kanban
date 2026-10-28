import { sync } from "./lib.mjs";
export default async () => { await sync(); };
export const config = { schedule: "@hourly" };
