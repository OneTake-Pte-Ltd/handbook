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

const db = fromBunnyClient(connect({ timeout: 20_000 }));
const app = createApp({ db, env: process.env });

BunnySDK.net.http.serve((request) => app.handle(request));
