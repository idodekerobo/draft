import { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://draftai.us',
      lastModified: new Date(),
      changeFrequency: 'weekly', // TODO: update to monthly after launch
      priority: 1,
    },
    {
      url: 'https://draftai.us/download',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
    {
      url: 'https://draftai.us/join',
      lastModified: new Date(),
      changeFrequency: 'monthly',
      priority: 0.8,
    },
  ]
}
