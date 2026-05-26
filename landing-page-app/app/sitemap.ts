import { MetadataRoute } from 'next'

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: 'https://draftai.us',
      lastModified: new Date(),
      changeFrequency: 'weekly', // TODO: update to monthly after launch
      priority: 1,
    },
  ]
}
