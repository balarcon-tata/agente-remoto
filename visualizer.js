(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SocratesVisualizer=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const norm=s=>(s??'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9:+/.-]+/g,' ').trim();
  const graphWords=/\b(grafica|grafico|graficame|graficar|graficamente|visualiza|visualizame|chart|plot|diagrama)\b/;
  const stripGraphWords=s=>String(s||'').replace(/\b(grafica(?:me)?|grafico|graficar|graficamente|visualiza(?:me)?|chart|plot|diagrama)\b/gi,' ').replace(/\s+/g,' ').trim();
  const num=v=>Number(v)||0;
  function isExplicit(text){return graphWords.test(norm(text));}
  function titleCaseMetric(m){return m==='units'?'Unidades':m==='hc'?'HC':m==='sam'?'SAM':m==='efficiency'?'Eficiencia':String(m||'Valor');}
  function semanticResult(entity,rows,metric,scope,focus=true){
    const clean=(rows||[]).map(x=>({...x}));
    const first=clean[0]||null;
    return{entity,rows:clean,metric,scope:{...(scope||{})},kind:'visual',focus:focus&&first?(first.key??first[entity]??first.label??null):null};
  }
  function wrapLabel(label,maxChars=18,maxLines=2){
    const text=String(label??'').trim(); if(!text)return [''];
    const words=text.split(/\s+/).filter(Boolean);
    if(words.length===1){
      return words[0].length<=maxChars?[words[0]]:[words[0].slice(0,maxChars-1)+'…'];
    }
    // Balance two readable lines instead of packing/truncating the first words.
    let best=null;
    for(let cut=1;cut<words.length;cut++){
      const a=words.slice(0,cut).join(' '),b=words.slice(cut).join(' ');
      const overflow=Math.max(0,a.length-maxChars)+Math.max(0,b.length-maxChars);
      const imbalance=Math.abs(a.length-b.length);
      const score=overflow*100+imbalance;
      if(!best||score<best.score)best={a,b,score};
    }
    let lines=best?[best.a,best.b]:[text];
    lines=lines.slice(0,maxLines).map(x=>x.length>maxChars?x.slice(0,maxChars-1).trimEnd()+'…':x);
    return lines;
  }
  function scopeRows(rows,scope={}){
    return (rows||[]).filter(r=>(!scope.line||r.linea===scope.line)&&(!scope.date||String(r.fecha).slice(0,10)===String(scope.date).slice(0,10))&&(!scope.order||r.orden===scope.order)&&(!scope.style||String(r.estilo)===String(scope.style))&&(!scope.operation||(r.operaciones||[]).some(o=>o.operacion===scope.operation)));
  }
  function effectiveScope(text,state,rows,core,engine){
    let filters={...(state?.scope||{})};
    try{
      const bp=engine.buildPlan(stripGraphWords(text),state,rows,core);
      filters={...filters,...Object.fromEntries(Object.entries(bp?.plan?.filters||{}).filter(([,v])=>v))};
      for(const [k,v] of Object.entries(bp?.refs?.filters||{}))if(v)filters[k]=v;
    }catch{}
    if(state?.focus?.entity&&state.focus.value){
      const e=state.focus.entity,v=state.focus.value;
      if(e==='day'&&!filters.date)filters.date=v;
      if(e==='order'&&!filters.order)filters.order=v;
      if(e==='style'&&!filters.style)filters.style=v;
      if(e==='operation'&&!filters.operation)filters.operation=v;
      if(e==='line'&&!filters.line)filters.line=v;
      if(state.focus.scope)filters={...state.focus.scope,...filters};
    }
    return filters;
  }
  function scenarioSpec(text,ctx){
    const {rows,state,scenario,core,engine}=ctx;
    if(!scenario?.active||!Array.isArray(scenario.changes)||!scenario.changes.length)return null;
    const n=norm(text);
    if(!(/\b(real|plan real|simulad|escenario|vs|contra|compar)\b/.test(n)))return null;
    const last=scenario.changes[scenario.changes.length-1];
    const scope={...(last.scope||effectiveScope(text,state,rows,core,engine))};
    const base=scopeRows(rows,scope);
    const simAll=engine.applyScenario(rows,scenario.changes);
    const sim=scopeRows(simAll,scope);
    const dates=[...new Set([...base,...sim].map(r=>String(r.fecha).slice(0,10)))].sort();
    if(!dates.length)return null;
    const aggregate=(arr,d)=>arr.filter(r=>String(r.fecha).slice(0,10)===d).reduce((s,r)=>s+num(r.hc),0);
    return {
      kind:'multi',chart:'bar',title:'HC real vs. simulado',labels:dates,
      series:[{name:'HC real',values:dates.map(d=>aggregate(base,d))},{name:'HC simulado',values:dates.map(d=>aggregate(sim,d))}],
      scope,caption:'Escenario local; no modifica el balance real ni Supabase.'
    };
  }
  function operationsSpec(text,ctx){
    const {rows,state,core,engine}=ctx,n=norm(text);
    if(!/\boperacion/.test(n))return null;
    const scope=effectiveScope(text,state,rows,core,engine);
    // If user says "esa orden", prefer the canonical order focus/scope and do not retain an old operation filter.
    if(/\b(esa orden|de esa orden|dentro de esa orden)\b/.test(n)){
      const ord=state?.focus?.entity==='order'?state.focus.value:(state?.focus?.scope?.order||state?.scope?.order||scope.order);
      if(ord)scope.order=ord;
      scope.operation=null;
    }
    const rr=scopeRows(rows,scope);
    if(!rr.length)return null;
    const ops=core.aggOps(rr).sort((a,b)=>num(b.hc)-num(a.hc)).slice(0,6);
    if(!ops.length)return null;
    const metric=/\b(unidades|demanda|volumen)\b/.test(n)?'units':/\bsam\b/.test(n)?'sam':'hc';
    return {kind:'single',chart:'bar',title:`${titleCaseMetric(metric)} por operación`,labels:ops.map(x=>x.key),series:[{name:titleCaseMetric(metric),values:ops.map(x=>num(x[metric]))}],scope,caption:scope.order?`Orden ${scope.order}`:scope.line?`Línea ${scope.line}`:'',semantic:semanticResult('operation',ops,metric,scope,true)};
  }
  function byDaySpec(text,ctx){
    const {rows,state,core,engine}=ctx,n=norm(text);
    if(!/\b(por dia|cada dia|dia a dia|diario|semana)\b/.test(n))return null;
    const scope=effectiveScope(text,state,rows,core,engine); scope.date=null;
    const rr=scopeRows(rows,scope); if(!rr.length)return null;
    const d=core.agg(rr,'day').sort((a,b)=>String(a.key).localeCompare(String(b.key)));
    if(!d.length)return null;
    const wantsU=/\b(unidades|demanda|volumen)\b/.test(n),wantsH=/\bhc\b/.test(n);
    if(wantsU&&wantsH)return {kind:'dual',chart:'line',title:'Unidades y HC por día',labels:d.map(x=>x.key),series:[{name:'Unidades',values:d.map(x=>num(x.units)),axis:'left'},{name:'HC',values:d.map(x=>num(x.hc)),axis:'right'}],scope,semantic:semanticResult('day',d,'multi',scope,false)};
    const metric=wantsH?'hc':'units';
    return {kind:'single',chart:'line',title:`${titleCaseMetric(metric)} por día`,labels:d.map(x=>x.key),series:[{name:titleCaseMetric(metric),values:d.map(x=>num(x[metric]))}],scope,semantic:semanticResult('day',d,metric,scope,false)};
  }
  function genericSpec(text,ctx){
    const {rows,state,core,engine}=ctx;
    let bp=null;try{bp=engine.buildPlan(stripGraphWords(text),state,rows,core)}catch{return null}
    if(!bp?.plan)return null;
    const p=bp.plan,r=core.execute(rows,p,state?.scope||{}); if(!r?.ok||!Array.isArray(r.data)||r.data.length<1)return null;
    const metric=p.metric==='multi'?'hc':p.metric;
    const data=r.data.slice(0,12);
    const entity=p.target==='day'||p.groupBy==='date'?'day':(p.target||p.groupBy||null);
    return {kind:'single',chart:(entity==='day')?'line':'bar',title:`${titleCaseMetric(metric)} por ${p.target||p.groupBy||'elemento'}`,labels:data.map(x=>x.key??x.label??''),series:[{name:titleCaseMetric(metric),values:data.map(x=>num(x[metric]??(metric==='units'?x.unidades:0)))}],scope:p.filters||{},semantic:entity?semanticResult(entity,data,metric,p.filters||{},p.action==='rank'):null};
  }
  function build(text,ctx){
    if(!isExplicit(text))return null;
    return scenarioSpec(text,ctx)||operationsSpec(text,ctx)||byDaySpec(text,ctx)||genericSpec(text,ctx)||{kind:'message',message:'Entendí que quieres una gráfica, pero necesito que indiques qué quieres visualizar: HC, unidades, operaciones, días o real vs. simulado.'};
  }
  function autoFromExecution(text,plan,result,ctx){
    if(isExplicit(text))return null;
    if(!plan||!result?.ok)return null;
    // Conservative auto mode: rankings with at least 3 rows are useful visually.
    if(plan.action==='rank'&&Array.isArray(result.data)&&result.data.length>=3){
      const metric=plan.metric==='multi'?'hc':plan.metric;
      const d=result.data.slice(0,6);
      return {kind:'single',chart:'bar',title:`Ranking visual · ${titleCaseMetric(metric)}`,labels:d.map(x=>x.key??x.label??''),series:[{name:titleCaseMetric(metric),values:d.map(x=>num(x[metric]??(metric==='units'?x.unidades:0)))}],scope:plan.filters||{},auto:true};
    }
    return null;
  }
  return{norm,isExplicit,build,autoFromExecution,scopeRows,effectiveScope,semanticResult,wrapLabel};
});