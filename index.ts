// backend/index.ts
import { serve } from "bun";
import { Database } from "bun:sqlite";
import { join, resolve } from "path";
import { existsSync, mkdirSync, unlinkSync } from "fs";
import { readFile } from "fs/promises";
import { randomUUID } from "crypto";

// Configuration
const UPLOAD_DIR = resolve("uploads");
const MAX_FILE_SIZE = 150 * 1024 * 1024; // 150MB in bytes
const TTL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Ensure uploads directory exists
if (!existsSync(UPLOAD_DIR)) {
  mkdirSync(UPLOAD_DIR);
}

// Initialize SQLite database
const db = new Database("database.sqlite", { create: true });
db.run(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    filename TEXT NOT NULL,
    expires INTEGER NOT NULL
  )
`);

// Clean up expired files
function cleanupExpiredFiles() {
  const now = Date.now();
  const expired = db
    .query("SELECT id, path FROM files WHERE expires < ?")
    .all(now) as { id: string; path: string }[];

  for (const { id, path } of expired) {
    try {
      unlinkSync(path); // Delete file from disk
      db.run("DELETE FROM files WHERE id = ?", id); // Remove from database
    } catch (e) {
      console.error(`Failed to delete file ${path}:`, e);
    }
  }
}

serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    // Upload endpoint
    if (req.method === "POST" && url.pathname === "/upload") {
      const formData = await req.formData();
      const uploadedFile = formData.get("file") as File;

      if (!uploadedFile) {
        return new Response("No file uploaded", { status: 400 });
      }

      if (uploadedFile.size > MAX_FILE_SIZE) {
        return new Response("File exceeds 150MB limit", { status: 413 });
      }

      const fileId = randomUUID().toString();
      const filePath = join(UPLOAD_DIR, `${fileId}.enc`);
      const fileData = new Uint8Array(await uploadedFile.arrayBuffer());
      const originalFilename = uploadedFile.name;

      // Write encrypted file to disk
      await Bun.write(filePath, fileData);

      // Store metadata in SQLite, including original filename
      const expires = Date.now() + TTL;
      db.run(
        "INSERT INTO files (id, path, filename, expires) VALUES (?, ?, ?, ?)",
        fileId,
        filePath,
        originalFilename,
        expires
      );

      // Clean up expired files
      cleanupExpiredFiles();

      // Return fileId and filename to frontend
      return new Response(
        JSON.stringify({ fileId, filename: originalFilename }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Download endpoint
    if (req.method === "GET" && url.pathname.startsWith("/download/")) {
      const fileId = url.pathname.split("/download/")[1];

      if (!fileId) {
        return new Response("File ID not provided", { status: 400 });
      }

      const fileRecord = db
        .query("SELECT path, filename, expires FROM files WHERE id = ?")
        .get(fileId) as {
        path: string;
        filename: string;
        expires: number;
      } | null;

      if (!fileRecord || fileRecord.expires < Date.now()) {
        cleanupExpiredFiles(); // Ensure expired files are removed
        return new Response("File not found or expired", { status: 404 });
      }

      const fileData = await readFile(fileRecord.path);
      return new Response(fileData, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${fileRecord.filename}"`,
        },
      });
    }

    // Serve frontend files
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(Bun.file("public/index.html"));
    }
    if (req.method === "GET" && url.pathname === "/download.html") {
      return new Response(Bun.file("public/download.html"));
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log("Server running on http://localhost:3000");

// Run cleanup periodically (every 5 minutes)
setInterval(cleanupExpiredFiles, 5 * 60 * 1000);
