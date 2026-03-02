import * as p from "@clack/prompts";

import { clean } from "./clean";
import { create } from "./create";
import { list } from "./list";
import { remove } from "./remove";

const EXIT_SUCCESS = 0;

/**
 * Interactive workspace command menu.
 */
export async function interactive(): Promise<void> {
  console.log("");
  p.intro("Workspace");

  const action = await p.select({
    message: "What would you like to do?",
    options: [
      { value: "create", label: "Create", hint: "scaffold a new package" },
      { value: "remove", label: "Remove", hint: "delete a package" },
      { value: "list", label: "List", hint: "show all packages" },
      { value: "clean", label: "Clean", hint: "remove build artifacts" },
      {
        value: "clean-all",
        label: "Clean All",
        hint: "remove build artifacts + node_modules",
      },
    ],
  });

  if (p.isCancel(action)) {
    p.cancel("Cancelled");
    process.exit(EXIT_SUCCESS);
  }

  switch (action) {
    case "create": {
      await create({ silent: true });
      break;
    }
    case "remove": {
      await remove({ silent: true });
      break;
    }
    case "list": {
      await list();
      break;
    }
    case "clean": {
      await clean({ silent: true });
      break;
    }
    case "clean-all": {
      await clean({ all: true, silent: true });
      break;
    }
  }

  p.outro("Done");
}
