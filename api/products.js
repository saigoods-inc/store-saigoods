import { readFileSync } from "node:fs";
import { getStorePath } from "../lib/store.js";
import { mergeInventoryIntoStore } from "../lib/stock.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const raw = readFileSync(getStorePath(), "utf8");
    const store = JSON.parse(raw);
    res.status(200).json(await mergeInventoryIntoStore(store));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load products." });
  }
}

