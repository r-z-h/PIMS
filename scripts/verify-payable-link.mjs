/**
 * 用真实后端验证「录成本 → 自动生成应付单 → 登记已付 → 冲销」整条链路。
 * 用临时库，不碰正式库。
 * 用法：node scripts/verify-payable-link.mjs （需后端已在 8033 运行）
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
  const proj = await api('POST', '/api/projects', {
    name: '联动验证项目', client_budget: 1000000, cost_budget: 800000,
  });
  const pid = proj.data.id;
  console.log(`   [信息] 临时项目 id=${pid}`);

  // 1) 录一笔材料 10000
  const mat = await api('POST', '/api/costs/material', {
    project_id: pid, material_name: '水泥', unit: '吨', quantity: 25, unit_price: 400,
    supplier: '某建材', biz_date: '2026-10-15',
  });
  check('录材料成本成功', mat.code === 0, `cost_id=${mat.data?.cost_id} amount=${mat.data?.amount}`);
  const costId = mat.data.cost_id;

  // 2) 应付单自动生成
  const p1 = await api('GET', `/api/costs/${costId}/payable`);
  const arap = p1.data?.arap ?? {};
  check('自动生成应付单（金额＝成本全额 10000）', p1.data?.has_payable === true && Number(arap.amount) === 10000,
    `amount=${arap.amount} biz_type=${arap.biz_type} partner=${arap.partner} status=${arap.status}`);
  check('应付单关联到该成本（cost_id）', Number(arap.cost_id) === Number(costId), `cost_id=${arap.cost_id}`);
  check('应付单类型=材料款、对方=供应商', arap.biz_type === 'material' && arap.partner === '某建材');

  // 3) 登记已付 3000
  const pay = await api('POST', `/api/costs/${costId}/pay`, {
    paid_amount: 3000, pay_method: 'transfer', pay_date: '2026-10-16', remark: '首付',
  });
  check('登记已付 3000 成功', pay.code === 0 && pay.data?.recorded === true, JSON.stringify(pay.data).slice(0, 160));
  check('生成了付款流水', Boolean(pay.data?.funds_flow_id), `flow_id=${pay.data?.funds_flow_id}`);
  check('自动冲销了应付单（状态 部分）', pay.data?.arap?.status === 'partial',
    `status=${pay.data?.arap?.status} settled=${pay.data?.arap?.settled_amount}`);

  // 4) 未结 = 7000
  const p2 = await api('GET', `/api/costs/${costId}/payable`);
  check('未结金额 = 7000', Number(p2.data?.unsettled) === 7000, `unsettled=${p2.data?.unsettled}`);
  check('冲销记录 1 条', (p2.data?.offsets ?? []).length === 1);

  // 5) 付款流水在收/付款页可见且已冲销 3000
  const flows = await api('GET', `/api/funds?project_id=${pid}&direction=out`);
  const flow = (flows.data?.items ?? [])[0];
  check('付款流水已记录（金额 3000、已冲销 3000）',
    Number(flow?.amount) === 3000 && Number(flow?.offset_amount) === 3000,
    `amount=${flow?.amount} offset=${flow?.offset_amount} method=${flow?.pay_method}`);

  // 6) 已付超过未结 → 400
  const over = await api('POST', `/api/costs/${costId}/pay`, { paid_amount: 999999 });
  check('已付超过未结被拒绝（400）', over.code === 400, over.message);

  // 7) 改成本金额（未冲销的那笔）→ 应付单跟着改
  //    注意：**已被冲销过**的成本按约定会被拒绝改金额（见第 8 步），所以这里另录一笔未付款的
  const matUnpaid = await api('POST', '/api/costs/machine', {
    project_id: pid, machine_name: '挖机', measure: 'shift', quantity: 3, unit_price: 2000,
    lessor: '李老板', biz_date: '2026-10-15',
  });
  const costUnpaid = matUnpaid.data.cost_id;
  const before = await api('GET', `/api/costs/${costUnpaid}/payable`);
  check('未付款的成本也自动生成应付单（6000）', Number(before.data?.arap?.amount) === 6000,
    `amount=${before.data?.arap?.amount}`);

  const upd = await api('PUT', `/api/costs/${costUnpaid}`, { amount: 7500 });
  check('未冲销时改成本金额成功', upd.code === 0, upd.code === 0 ? '' : JSON.stringify(upd).slice(0, 160));
  const p3 = await api('GET', `/api/costs/${costUnpaid}/payable`);
  check('应付单金额实时跟着改为 7500', Number(p3.data?.arap?.amount) === 7500, `amount=${p3.data?.arap?.amount}`);
  check('未结同步为 7500（无冲销）', Number(p3.data?.unsettled) === 7500, `unsettled=${p3.data?.unsettled}`);

  // 8) 已登记过已付的那笔再改金额 → 拒绝
  const rejectPaid = await api('PUT', `/api/costs/${costId}`, { amount: 5000 });
  check('已被冲销的成本改金额被拒绝并提示撤销',
    rejectPaid.code === 400 && String(rejectPaid.message).includes('撤销'), rejectPaid.message);

  // 9) 撤销冲销后可以改
  const offsetId = p2.data?.offsets?.[0]?.id;
  const revoke = await api('DELETE', `/api/arap/offset/${offsetId}`);
  check('撤销冲销成功', revoke.code === 0, JSON.stringify(revoke).slice(0, 120));
  const upd2 = await api('PUT', `/api/costs/${costId}`, { amount: 12000 });
  check('撤销冲销后可以改成本金额', upd2.code === 0, upd2.code === 0 ? '' : JSON.stringify(upd2).slice(0, 160));
  const p4 = await api('GET', `/api/costs/${costId}/payable`);
  check('应付单金额同步为 12000 且状态回到未收付',
    Number(p4.data?.arap?.amount) === 12000 && p4.data?.arap?.status === 'open',
    `amount=${p4.data?.arap?.amount} status=${p4.data?.arap?.status}`);

  // 10) 删除成本 → 应付单保留 + 提示（另录一笔专门用来删）
  const mat2 = await api('POST', '/api/costs/misc', {
    project_id: pid, category: '伙食费', amount: 800, biz_date: '2026-10-15',
  });
  const cost2 = mat2.data.cost_id;
  await api('POST', `/api/costs/${cost2}/pay`, { paid_amount: 300 });
  const del = await api('DELETE', `/api/costs/${cost2}`);
  check('删除成本返回"应付单已保留"提示',
    del.code === 0 && del.data?.payable?.kept === true, del.data?.payable?.message);

  // 11) 应付单确实还在往来列表里
  const payables = await api('GET', `/api/arap?type=payable&project_id=${pid}`);
  const ids = (payables.data?.items ?? []).map((r) => r.id);
  check('删除成本后应付单仍在往来列表', ids.includes(del.data?.payable?.payable_id), `payable_ids=${ids}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n================ 汇总：通过 ${results.length - failed.length} 项，失败 ${failed.length} 项 ================`);
  failed.forEach((f) => console.log('  失败：' + f.name));
  process.exit(failed.length ? 1 : 0);
};

main().catch((e) => {
  console.error('验证脚本异常：', e.message);
  process.exit(1);
});
