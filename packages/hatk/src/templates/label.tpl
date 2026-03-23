import { defineLabel } from '$hatk'

export default defineLabel({
  definition: {
    identifier: '{{name}}',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'warn',
    locales: [{ lang: 'en', name: '{{Name}}', description: 'Description here' }],
  },
  async evaluate(ctx) {
    // Return array of label identifiers to apply, or empty array
    return []
  },
})
