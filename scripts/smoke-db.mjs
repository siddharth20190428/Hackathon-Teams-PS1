import { MongoClient } from "mongodb";
const c = new MongoClient(process.env.MONGODB_URI);
await c.connect();
const db = c.db();
await c.withSession((s) =>
  s.withTransaction(async () => {
    await db.collection("a").insertOne({ x: 1 }, { session: s });
    await db.collection("b").insertOne({ y: 1 }, { session: s });
  }),
);
console.log("transaction ok");
await c.close();
