import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import { digestsLoader } from "./lib/digests-loader.js";

const digestArticleRef = z.object({
  title: z.string(),
  link: z.string(),
  feedName: z.string(),
});

const digests = defineCollection({
  loader: digestsLoader(),
  schema: z.object({
    date: z.string(),
    generatedAt: z.string(),
    hasNewArticles: z.boolean(),
    threeLines: z.array(z.string()),
    picks: z.array(digestArticleRef.extend({ reason: z.string() })),
    categories: z.array(
      z.object({
        category: z.string(),
        articles: z.array(digestArticleRef.extend({ gist: z.string() })),
      }),
    ),
  }),
});

export const collections = { digests };
