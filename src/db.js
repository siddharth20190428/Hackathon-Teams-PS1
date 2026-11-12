import { MongoClient } from 'mongodb';

export async function connect(uri = process.env.MONGODB_URI) {
  const client = new MongoClient(uri, { maxPoolSize: 100 });
  await client.connect();
  return { client, db: client.db() };
}
