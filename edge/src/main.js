// Entry point of the edge script. `node edge/build.mjs` joins this file and
// every module it imports into one file, which is what gets deployed to Bunny.
//
// Secrets read here (set them on the edge script in the Bunny dashboard):
//   BUNNY_DATABASE_URL, BUNNY_DATABASE_AUTH_TOKEN  added by "Add Secrets to Edge Script"
//   ALLOWED_ORIGINS                                 comma-separated frontend origins
//   SETUP_CODE                                      one-time code for the first admin
//   STORAGE_ZONE, STORAGE_KEY, STORAGE_REGION_HOST, PUBLIC_FILES_URL  (milestone 5)

import * as BunnySDK from "npm:@bunny.net/edgescript-sdk@0.13.0";
import { connect } from "npm:@bunny.net/database-client@0.0.3";
import process from "node:process";
import { createApp } from "./app.js";
import { fromBunnyClient } from "./lib/db.js";
import { HttpError } from "./lib/http.js";

// Connects on first use, so a missing secret becomes a readable API error
// instead of a script that fails to start.
let client = null;
function bunnyClient() {
  if (!client) {
    if (!process.env.BUNNY_DATABASE_URL || !process.env.BUNNY_DATABASE_AUTH_TOKEN) {
      throw new HttpError(
        503,
        "The database is not connected to this edge script. In Bunny, open the database, then Access, and click Add Secrets to Edge Script.",
      );
    }
    client = connect({ timeout: 20_000 });
  }
  return client;
}

const db = fromBunnyClient(bunnyClient);
const app = createApp({ db, env: process.env });

BunnySDK.net.http.serve((request) => app.handle(request));
