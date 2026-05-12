import { defineCollection, z } from 'astro:content';

const projects = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    subtitle: z.string().optional(),
    description: z.string().optional(),
    date: z.coerce.date().optional(),
    course: z.string().optional(),
    semester: z.string().optional(),
    team: z.string().optional(),
    role: z.string().optional(),
    stack: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    liveUrl: z.string().url().optional(),
    repoUrl: z.string().url().optional(),
    repo: z.string().url().optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    status: z.string().optional(),
  }),
});

const writing = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { projects, writing };
