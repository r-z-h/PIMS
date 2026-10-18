/**
 * 补充接口验证（覆盖 verify-payable-link.mjs 没覆盖到的口径）：
 *   1) 五类成本**各录一笔**，逐一核对自动生成的应付单：类型标签、对方映射、金额＝成本全额
 *   2) 「登记已付」四字段全部选填：不填金额（等价于关掉弹窗）→ 应付单全额挂账、无付款流水
 *   3) 金额带小数时的同步（应付单金额跟随成本金额，不丢精度）
 * 用临时库，不碰正式库。用法：node scripts/verify-payable-types.mjs（后端需在 8033）
 */
const API = process.env.PIMS_API || 'http://127.0.0.1:8033';
let cookie = '';

async function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  (r.headers.getSetCookie?.() ?? []).forEach((c) => {
    const pair = c.split(';')[0];
    if (pair.startsWith('pims_session=')) cookie = pair;
  });
  return r.json();
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  :: ' + detail : ''}`);
};

const main = async () => {
  const login = await api('POST', '/api/auth/login', { password: '123456' });
  if (login.code !== 0) throw new Error('登录失败: ' + JSON.stringify(login));
  if (login.data.security_ready === false) {
    await api('POST', '/api/auth/security/setup', {
      questions: [
        { question: '补验问题1', answer: '答案1' },
        { question: '补验问题2', answer: '答案2' },
        { question: '补验问题3', answer: '答案3' },
      ],
    });
  }
  const proj = await api('POST', '/api/projects', { name: '五类联动补验', client_budget: 500000, cost_budget: 400000 });
  const pid = proj.data.id;
  console.log(`   [信息] 临时项目 id=${pid}`);

  const cases = [
    { label: '人工', path: '/api/costs/labor', payload: { project_id: pid, worker_name: '张三', work_days: 3.5, day_rate: 300, amount: 1050, biz_date: '2026-10-15' }, amount: 1050, bizType: 'labor', partner: '张三' },
    { label: '材料', path: '/api/costs/material', payload: { project_id: pid, material_name: '水泥', unit: '吨', quantity: 2, unit_price: 400, amount: 800, supplier: '某建材', biz_date: '2026-10-15' }, amount: 800, bizType: 'material', partner: '某建材' },
    { label: '机械', path: '/api/costs/machine', payload: { project_id: pid, machine_name: '挖机', measure: 'shift', quantity: 2, unit_price: 1200, amount: 2400, lessor: '李老板', biz_date: '2026-10-15' }, amount: 2400, bizType: 'machine', partner: '李老板' },
    { label: '杂费', path: '/api/costs/misc', payload: { project_id: pid, category: '伙食费', amount: 1234.56, biz_date: '2026-10-15' }, amount: 1234.56, bizType: 'misc', partner: null },
    // 垫付的应付单类型是 advance_pay（前端标签「垫付」，见 utils/enums.ts 与 schema.sql 的 CHECK）
    { label: '垫付', path: '/api/costs/advance', payload: { project_id: pid, payer: '王老板', purpose: '临时买料', amount: 500, biz_date: '2026-10-15' }, amount: 500, bizType: 'advance_pay', partner: '王老板' },
  ];

  for (const c of cases) {
    const created = await api('POST', c.path, c.payload);
    if (created.code !== 0) {
      check(`${c.label}：录入成功`, false, JSON.stringify(created).slice(0, 160));
      continue;
    }
    const costId = created.data.cost_id;
    const p = await api('GET', `/api/costs/${costId}/payable`);
    const arap = p.data?.arap ?? {};
    const amountOk = Number(arap.amount) === c.amount;
    const linkOk = Number(arap.cost_id) === Number(costId);
    const typeOk = arap.biz_type === c.bizType;
    const partnerOk = (arap.partner ?? null) === c.partner;
    check(`${c.label}：自动生成应付单（金额 ${c.amount}、类型 ${c.bizType}、对方 ${c.partner ?? '（无对方字段）'}、关联成本）`,
      p.data?.has_payable === true && amountOk && linkOk && typeOk && partnerOk,
      `amount=${arap.amount} biz_type=${arap.biz_type} partner=${JSON.stringify(arap.partner)} cost_id=${arap.cost_id} status=${arap.status} unsettled=${p.data?.unsettled}`);

    // 不填已付金额（等价于「直接关掉弹窗」）→ 全额挂账、不生成流水
    const noPay = await api('POST', `/api/costs/${costId}/pay`, { paid_amount: null, pay_method: null, pay_date: null, remark: null });
    const after = await api('GET', `/api/costs/${costId}/payable`);
    check(`${c.label}：不填已付金额 → 不生成流水、应付单全额挂账`,
      noPay.code === 0 && noPay.data?.recorded === false && noPay.data?.funds_flow_id == null
        && Number(after.data?.unsettled) === c.amount && (after.data?.offsets ?? []).length === 0,
      `recorded=${noPay.data?.recorded} reason=${noPay.data?.reason} unsettled=${after.data?.unsettled} status=${after.data?.arap?.status}`);
  }

  // 改金额（未冲销）→ 应付单同步；小数不丢精度
  const anyCost = await api('GET', `/api/costs?project_id=${pid}&type=misc&page=1&page_size=5`);
  const miscId = anyCost.data.items[0].id;
  const upd = await api('PUT', `/api/costs/${miscId}`, { amount: 2000.01 });
  const afterUpd = await api('GET', `/api/costs/${miscId}/payable`);
  check('未冲销时改成本金额（2000.01）→ 应付单金额精确同步',
    upd.code === 0 && Number(afterUpd.data?.arap?.amount) === 2000.01,
    `amount=${afterUpd.data?.arap?.amount}`);

  // 付款流水方向/类型：垫付的付款也要能冲销（走一遍完整链路）
  const adv = await api('GET', `/api/costs?project_id=${pid}&type=advance&page=1&page_size=5`);
  const advId = adv.data.items[0].id;
  const pay = await api('POST', `/api/costs/${advId}/pay`, { paid_amount: 200, pay_method: 'cash', pay_date: '2026-10-14', remark: '补验垫付' });
  const advAfter = await api('GET', `/api/costs/${advId}/payable`);
  check('垫付成本登记已付 200 → 冲销成功、未结 300、状态部分',
    pay.code === 0 && pay.data?.recorded === true && Number(advAfter.data?.unsettled) === 300 && advAfter.data?.arap?.status === 'partial',
    `unsettled=${advAfter.data?.unsettled} status=${advAfter.data?.arap?.status} flow_id=${pay.data?.funds_flow_id}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n================ 补验汇总：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项 ================`);
  failed.forEach((f) => console.log('  失败：' + f.name));
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error('补验脚本异常：', e.message);
  process.exit(1);
});
