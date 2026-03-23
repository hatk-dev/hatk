import type { OpengraphContext, OpengraphResult } from '@hatk/hatk/opengraph'

export default {
  path: '/og/{{name}}/:id',
  async generate(ctx: OpengraphContext): Promise<OpengraphResult> {
    const { db, params } = ctx
    return {
      element: {
        type: 'div',
        props: {
          style: { display: 'flex', width: '100%', height: '100%', background: '#080b12', color: 'white', alignItems: 'center', justifyContent: 'center' },
          children: params.id,
        },
      },
    }
  },
}
