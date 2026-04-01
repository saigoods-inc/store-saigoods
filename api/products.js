import { loadStore } from "../lib/store.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const store = loadStore();
    res.status(200).json(store);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to load products." });
  }
}

