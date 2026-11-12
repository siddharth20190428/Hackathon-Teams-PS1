import { MongoMemoryReplSet } from "mongodb-memory-server";

const rs = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: "wiredTiger" },
  instanceOpts: [{ port: 27017 }],
});
console.log("Mongo ready:", rs.getUri("teams_dev"));
process.on("SIGINT", async () => {
  await rs.stop();
  process.exit(0);
});
await new Promise(() => {});
