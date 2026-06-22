import type { CommandModule } from "yargs";
import { getAccessToken } from "../auth/auth-client";

export async function runAuth(): Promise<void> {
  await getAccessToken();
  console.log("Signed in to developer.bentley.com");
}

export const authCommand: CommandModule = {
  command: "auth",
  describe: "Login to developer.bentley.com",
  builder: (y) => y,
  handler: async () => {
    await runAuth();
  },
};
