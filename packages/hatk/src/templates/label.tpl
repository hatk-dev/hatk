import type { LabelRuleContext } from '@hatk/hatk/labels'

export default {
  definition: {
    identifier: '{{name}}',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'warn',
    locales: [{ lang: 'en', name: '{{Name}}', description: 'Description here' }],
  },
  async evaluate(ctx: LabelRuleContext) {
    // Return array of label identifiers to apply, or empty array
    return []
  },
}
