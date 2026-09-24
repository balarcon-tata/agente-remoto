/* ============================================================
   SOCRATES ENGINE (V17) — MOTOR CONVERSACIONAL UNIFICADO
   ------------------------------------------------------------
   Reemplaza: conversation-engine.js, reasoner.js, semantic-planner.js
   y los estados paralelos `cx` / `scenarioState` del index.html.

   Una sola fuente de verdad (canonical state), un solo resolutor
   de referencias, un solo planificador/validador. El motor
   matemático determinístico (agg/aggOps/execute) se reutiliza
   de agent-core.js sin modificar sus fórmulas.

   Pipeline:
     normalizar -> resolver entidades/referencias -> intención ->
     construir plan -> validar plan -> ejecutar (backend) ->
     razonar sobre resultados -> responder
   ============================================================ */
(function(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SocratesEngine=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){

'use strict';

function freshState(){
  return {
    scope:{area:null,line:null,date:null,order:null,style:null,operation:null,metric:null},
    focus:{entity:null,value:null,scope:null},
    lastResult:{entity:null,rows:[],metric:null,scope:{},kind:null},
    lastQuery:{action:null,target:null,metric:null,groupBy:'none',criterion:null,output:'brief',requestedMetrics:[],semanticMode:null,filters:{}},
    analysisFrame:{action:null,target:null,metric:null,groupBy:'none',criterion:null,output:'brief',requestedMetrics:[],semanticMode:null,filters:{}},
    scenario:null
  };
}

function cloneState(s){return JSON.parse(JSON.stringify(s||freshState()));}

function norm(s){
  return (s??'').toString().normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
}


/* ============================================================
   V20 — MARCO SEMANTICO COMPUESTO
   Una pregunta puede pedir mas de una cosa a la vez.
   El plan ya no colapsa "mayor HC + su eficiencia" a una sola metrica.
   Tambien reconoce comparaciones entre posiciones del ultimo ranking.
   ============================================================ */
function requestedMetrics(text){
  const n=norm(text),out=[];
  const add=x=>{if(!out.includes(x))out.push(x)};
  if(/\b(hc|personal|personas|gente|recursos|headcount|carga|cargas)\b/.test(n))add('hc');
  if(/\b(unidades|unidad|volumen|demanda|cantidad|programad|planificad)\b/.test(n))add('units');
  if(/\b(sam|complejidad|complejo|dificil|dificultad|tiempo estandar)\b/.test(n))add('sam');
  if(/\b(eficiencia|eficiencias|eficiente|eficientes|ineficiente|ineficientes)\b/.test(n))add('efficiency');
  return out;
}
function primaryMetric(text,metrics,state){
  const n=norm(text),ms=metrics||requestedMetrics(text);
  if(/\b(mayor|menor|mas|menos|maximo|minimo|pico|concentra|aporta|requiere)\b[^.]{0,35}\b(hc|personal|personas|carga)\b/.test(n) || /\b(hc|personal|personas|carga)\b[^.]{0,25}\b(mayor|menor|mas|menos|maximo|minimo|pico)\b/.test(n))return'hc';
  if(/\b(mayor|menor|mas|menos|maximo|minimo|pico)\b[^.]{0,35}\b(unidades|demanda|volumen)\b/.test(n))return'units';
  if(/\b(mayor|menor|mas|menos|maximo|minimo)\b[^.]{0,35}\bsam\b/.test(n))return'sam';
  if(/\b(mayor|menor|mas|menos|maximo|minimo)\b[^.]{0,35}\beficiencia\b/.test(n))return'efficiency';
  if(ms.length===1)return ms[0];
  if(ms.includes('hc'))return'hc';
  return ms[0]||state?.scope?.metric||'multi';
}
function pairedOrdinalReference(text,state){
  const n=norm(text),last=state&&state.lastResult;
  if(!last||!last.entity||!Array.isArray(last.rows)||last.rows.length<2)return null;
  const hasFirst=/\b(primero|primera|#1|numero 1)\b/.test(n);
  const hasSecond=/\b(segundo|segunda|#2|numero 2)\b/.test(n);
  if(!hasFirst||!hasSecond)return null;
  return {entity:last.entity,rows:[last.rows[0],last.rows[1]],metric:last.metric||state?.scope?.metric||'hc',scope:{...(last.scope||{})}};
}
function effectiveMetricsForRows(rs,core){
  const units=core.uniqueUnits?core.uniqueUnits(rs):rs.reduce((z,r)=>z+(Number(r.unidades)||0),0);
  const hc=rs.reduce((z,r)=>z+(Number(r.hc)||0),0);
  const ops=core.aggOps(rs);
  const hcDen=ops.reduce((z,o)=>z+Math.max(Number(o.hc)||0,0),0);
  const efficiency=hcDen?ops.reduce((z,o)=>z+(Number(o.efficiency)||0)*Math.max(Number(o.hc)||0,0),0)/hcDen:0;
  const sam=units?rs.reduce((z,r)=>z+(Number(r.unidades)||0)*(r.operaciones||[]).reduce((a,o)=>a+(Number(o.sam)||0),0),0)/units:0;
  const hoursVals=rs.map(r=>Number(r.horas||r.hours)).filter(x=>Number.isFinite(x)&&x>0);
  const hours=hoursVals.length?hoursVals.reduce((a,b)=>a+b,0)/hoursVals.length:null;
  const topOperation=[...ops].sort((a,b)=>(Number(b.hc)||0)-(Number(a.hc)||0))[0]||null;
  return{units,hc,sam,efficiency,hours,topOperation};
}
function comparisonDiagnostics(pair,rows,core){
  if(!pair||!pair.entity||!Array.isArray(pair.rows)||pair.rows.length<2)return null;
  const scope=pair.scope||{};
  const make=row=>{
    const value=row.key??row[pair.entity]??row.label;
    let rs=core.filterRows(rows,{line:scope.line||null,date:scope.date||null,order:scope.order||null,style:scope.style||null,operation:scope.operation||null});
    if(pair.entity==='day')rs=rs.filter(r=>String(r.fecha)===String(value));
    if(pair.entity==='order')rs=rs.filter(r=>norm(r.orden)===norm(value));
    if(pair.entity==='style')rs=rs.filter(r=>String(r.estilo)===String(value));
    if(pair.entity==='line')rs=rs.filter(r=>norm(r.linea)===norm(value));
    if(pair.entity==='operation')rs=rs.filter(r=>(r.operaciones||[]).some(o=>norm(o.operacion)===norm(value)));
    const m=effectiveMetricsForRows(rs,core);
    if(pair.entity==='operation'){
      const op=core.aggOps(rs).find(o=>norm(o.key)===norm(value));
      if(op){m.hc=Number(op.hc)||0;m.units=Number(op.units)||0;m.sam=Number(op.sam)||0;m.efficiency=Number(op.efficiency)||0;m.topOperation=op;}
    }
    return{key:value,...m,source:{...row}};
  };
  return{entity:pair.entity,metric:pair.metric||'hc',scope,items:pair.rows.slice(0,2).map(make)};
}

const SCOPE_KEYS=['line','date','order','style','operation'];
const REF_PATTERNS={
  order:/\b(esa orden|esta orden|la orden anterior|esa misma orden|dicha orden)\b/,
  style:/\b(ese estilo|este estilo|el estilo anterior|ese mismo estilo|dicho estilo)\b/,
  operation:/\b(esa operacion|esa operación|esta operacion|esta operación|la operacion anterior|la operación anterior|dicha operacion|dicha operación|esa misma operacion|esa misma operación)\b/,
  date:/\b(ese dia|ese día|este dia|este día|el mismo dia|el mismo día|dicho dia|dicho día|el dia anterior|el día anterior)\b/,
  line:/\b(esa linea|esa línea|dicha linea|dicha línea|esa familia|esa misma linea|esa misma línea)\b/
};
const PLURAL_PATTERNS={
  operation:/\b(esas operaciones|estas operaciones)\b/,
  order:/\b(esas ordenes|esas órdenes|estas ordenes|estas órdenes)\b/,
  style:/\b(esos estilos|estos estilos)\b/
};

function ordinalIndex(text){
  const n=norm(text);
  if(/\b(primera|primero|#1|numero 1|número 1)\b/.test(n))return 0;
  if(/\b(segunda|segundo|#2|numero 2|número 2)\b/.test(n))return 1;
  if(/\b(tercera|tercero|#3|numero 3|número 3)\b/.test(n))return 2;
  if(/\b(cuarta|cuarto|#4|numero 4|número 4)\b/.test(n))return 3;
  if(/\b(quinta|quinto|#5|numero 5|número 5)\b/.test(n))return 4;
  return null;
}

function resolveOrdinal(text,state){
  const idx=ordinalIndex(text);
  const last=state.lastResult;
  if(idx===null||!last||!last.entity||!Array.isArray(last.rows)||!last.rows[idx])return null;
  const row=last.rows[idx];
  const value=row.key??row[last.entity]??row.label??null;
  if(value==null)return null;
  return {entity:last.entity,value};
}

function resolveSingularRef(type,state){
  const scopeKey=type==='date'?'date':type;
  const focusEntity=type==='date'?'day':type;
  if(state.focus&&state.focus.entity===focusEntity&&state.focus.value)return state.focus.value;
  if(state.scope&&state.scope[scopeKey])return state.scope[scopeKey];
  if(state.lastResult&&state.lastResult.entity===focusEntity&&state.lastResult.rows&&state.lastResult.rows[0]){
    const row=state.lastResult.rows[0];
    return row.key??row[state.lastResult.entity]??null;
  }
  return null;
}

// V17.3: descriptive references are resolved from the LAST semantic result.
// This is generic: entity + metric + superlative, not a dictionary of questions.
function resolveDescriptiveReference(text,state){
  const n=norm(text),last=state&&state.lastResult;
  if(!last||!last.entity||!Array.isArray(last.rows)||!last.rows.length)return null;

  let entity=null;
  if(/\boperacion(?:es)?\b/.test(n))entity='operation';
  else if(/\borden(?:es)?\b/.test(n))entity='order';
  else if(/\bestilo(?:s)?\b/.test(n))entity='style';
  else if(/\bdia(?:s)?\b/.test(n))entity='day';
  else if(/\b(linea|lineas|familia|familias)\b/.test(n))entity='line';
  if(!entity||last.entity!==entity)return null;

  let metric=null;
  if(/\b(hc|personal|personas|gente|headcount)\b/.test(n))metric='hc';
  else if(/\b(unidades|unidad|demanda|volumen|cantidad)\b/.test(n))metric='units';
  else if(/\bsam\b/.test(n))metric='sam';
  else if(/\beficiencia\b/.test(n))metric='efficiency';
  if(!metric)return null;

  let criterion=null;
  if(/\b(mayor|mas|alto|alta|maximo|pico|concentra|aporta)\b/.test(n))criterion='max';
  else if(/\b(menor|menos|bajo|baja|minimo)\b/.test(n))criterion='min';
  if(!criterion)return null;

  const valueOf=row=>{
    if(metric==='units')return Number(row.units??row.unidades)||0;
    if(metric==='efficiency')return Number(row.efficiency??row.eff)||0;
    return Number(row[metric])||0;
  };
  const ranked=[...last.rows].sort((a,b)=>criterion==='min'?valueOf(a)-valueOf(b):valueOf(b)-valueOf(a));
  const row=ranked[0];
  if(!row)return null;
  const value=row.key??row[entity]??row.label??null;
  if(value==null)return null;
  return{entity,value,metric,criterion,row,rows:ranked,scope:{...(last.scope||{})}};
}

// V21: possessive references bind to the MOST SPECIFIC current focus.
// "su eficiencia", "su SAM", "su HC", etc. do not fall back to the line
// when the current focus is an operation/order/style/day.
function resolvePossessiveFocus(text,state){
  const n=norm(text),f=state&&state.focus;
  if(!f||!f.entity||f.value==null)return null;
  const possessive=/\b(su|sus|del mismo|de la misma|de ese mismo|de esa misma)\b/.test(n);
  if(!possessive)return null;
  const metric=/\b(hc|unidades|unidad|sam|eficiencia|volumen|demanda|horas)\b/.test(n);
  if(!metric)return null;
  const key=f.entity==='day'?'date':f.entity;
  if(!SCOPE_KEYS.includes(key))return null;
  return{entity:f.entity,key,value:f.value,scope:{...(f.scope||{})}};
}

function isScenarioComparison(text,hasActive){
  if(!hasActive)return false;
  const n=norm(text);
  const compare=/\b(compara|comparame|comparalo|comparar|contra|versus|vs|diferencia)\b/.test(n);
  const scenarioWords=/\b(simulad|escenario|hipotetic|plan base|base|original|actual|real)\b/.test(n);
  // Si la misma frase introduce un NUEVO cambio y luego pide comparar, primero
  // hay que aplicar ese cambio. De lo contrario se compara el escenario viejo.
  const mutates=/\b(mejora|mejorar|sube|subir|baja|bajar|aumenta|aumentar|reduce|reducir|incrementa|incrementar|agrega|agregar|quita|quitar|cambia|cambiar|ajusta|ajustar)\b/.test(n) &&
    /\b(eficiencia|horas?|minutos?|unidades?|sam|puntos?)\b/.test(n);
  return compare&&scenarioWords&&!mutates;
}

function resolveReferences(text,state,core){
  const n=norm(text);
  const out={filters:{},collection:null,unresolved:[],ordinalApplied:null,descriptiveApplied:null,referenceScope:null};

  const poss=resolvePossessiveFocus(text,state);
  if(poss){
    out.filters[poss.key]=poss.value;
    out.referenceScope={...(poss.scope||{})};
    out.possessiveApplied=poss;
  }

  const ord=resolveOrdinal(text,state);
  if(ord){
    out.filters[ord.entity==='day'?'date':ord.entity]=ord.value;
    out.ordinalApplied=ord;
    out.referenceScope={...(state.lastResult?.scope||{})};
  }

  // Descriptions such as "la operación que más HC requiere" resolve
  // against the immediately previous semantic list/ranking.
  const desc=resolveDescriptiveReference(text,state);
  if(desc){
    out.filters[desc.entity==='day'?'date':desc.entity]=desc.value;
    out.descriptiveApplied=desc;
    out.referenceScope={...(desc.scope||state.lastResult?.scope||{})};
  }

  for(const type of Object.keys(REF_PATTERNS)){
    if(!REF_PATTERNS[type].test(n))continue;
    if(ord&&ord.entity===(type==='date'?'day':type))continue;
    const value=resolveSingularRef(type,state);
    if(value){
      out.filters[type==='date'?'date':type]=value;
      const focusEntity=type==='date'?'day':type;
      if(state.focus&&state.focus.entity===focusEntity&&state.focus.value===value){
        out.referenceScope={...(state.focus.scope||out.referenceScope||{})};
      }
    }else out.unresolved.push(type);
  }

  for(const type of Object.keys(PLURAL_PATTERNS)){
    if(!PLURAL_PATTERNS[type].test(n))continue;
    if(state.lastResult&&state.lastResult.entity===type){
      out.collection={entity:type,rows:state.lastResult.rows||[],scope:state.lastResult.scope||{}};
    }
  }

  return out;
}

function explicitEntities(text,rows,core){
  const base=core.explicit(text,rows),cats=core.catalogs(rows),n=norm(text);

  // Typed resolver: operations are resolved before lines. Tokens that belong to
  // an operation cannot also be used as evidence for a line.
  let operation=null,opNorm='';
  for(const op of [...cats.operations].sort((a,b)=>norm(b).length-norm(a).length)){
    const on=norm(op);
    if(on&&n.includes(on)){operation=op;opNorm=on;break;}
  }
  if(!operation&&base.operation){operation=base.operation;opNorm=norm(operation);}

  let residual=' '+n+' ';
  if(opNorm){
    residual=residual.replace(' '+opNorm+' ',' ');
    for(const tok of opNorm.split(' ').filter(x=>x.length>2)){
      const safe=tok.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      residual=residual.replace(new RegExp('\\b'+safe+'\\b','g'),' ');
    }
    residual=residual.replace(/\s+/g,' ').trim();
  }

  const generic=new Set(['atraque','modulo','linea','familia']);
  let line=null,lineScore=0;
  for(const raw of cats.lines||[]){
    const rn=norm(raw),label=rn.replace(/^\d+\s+/,''),code=(rn.match(/^\d+/)||[])[0]||'';
    const toks=label.split(' ').filter(x=>x.length>2&&!generic.has(x));
    let score=0;
    if(label&&n.includes(label))score=1;
    else if(label&&residual.includes(label))score=1;
    if(code&&new RegExp('\\b'+code+'\\b').test(n))score=1;
    const hits=toks.filter(t=>new RegExp('(^|\\s)'+t.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'($|\\s)').test(residual)).length;
    if(hits)score=Math.max(score,toks.length===1?.92:.76+.08*Math.min(hits-1,2));
    if(score>lineScore){lineScore=score;line=raw;}
  }
  if(lineScore<.75)line=null;

  const e={...base,line,operation};
  // Interrogativas de localización: "¿en qué línea está esa operación?".
  // Aquí "línea" es el atributo solicitado, no una entidad explícita.
  const asksWhichLine=/\b(?:en\s+)?(?:que|cual)\s+linea\b|\blinea\s+(?:esta|corresponde|pertenece)\b/.test(n);
  if(operation&&!line)e.invalidLine=null;
  if(asksWhichLine&&!line)e.invalidLine=null;
  if(!e.order){
    const upper=String(text||'').toUpperCase();let best=null,bestLen=0;
    for(const o of cats.orders){const ou=String(o).toUpperCase();if(ou.length>=4&&upper.includes(ou)&&ou.length>bestLen){best=o;bestLen=ou.length;}}
    if(best)e.order=best;
  }
  return e;
}

function needsModelPlan(text,plan,refs,state){
  if(!plan)return true;
  if(plan.action==='clarify'&&!(refs&&refs.unresolved&&refs.unresolved.length))return true;
  return false;
}

function modelPlannerPrompt(text,state,rows,core){
  const c=core.catalogs(rows);
  return `Eres SOLO un planificador semantico para Socrates. No calcules ni respondas. Devuelve JSON puro. Pregunta: ${text}. Contexto: ${JSON.stringify(state.scope||{})}. Lineas reales: ${c.lines.join(' | ')}. Schema: {"action":"aggregate|rank|group|detail|count|compare|analyze|explain|relationship|clarify","target":"area|line|order|style|operation|day","metric":"units|hc|sam|efficiency|count|date|style|multi","groupBy":"none|date|line|order|style|operation","criterion":"none|max|min","output":"brief|table|chart|analysis"}. No incluyas filtros ni nombres; las entidades se enlazan contra datos reales.`;
}

function bindModelPlan(text,raw,state,rows,core){
  const det=buildPlan(text,state,rows,core),p=sanitizePlan(raw,core),d=det.plan;
  p.filters={...(d.filters||{})};p.invalidLine=d.invalidLine||null;
  p.requestedMetrics=[...(d.requestedMetrics||[])];p.compareItems=d.compareItems||null;p.semanticMode=d.semanticMode||p.semanticMode||null;
  if(p.metric==='multi'&&d.metric!=='multi')p.metric=d.metric;
  if(p.target==='area'&&d.target!=='area')p.target=d.target;
  if(p.groupBy==='none'&&d.groupBy!=='none')p.groupBy=d.groupBy;
  if(p.criterion==='none'&&d.criterion!=='none')p.criterion=d.criterion;
  return{plan:reconcilePlanWithIntent(text,validateModelFilters(p,rows,core),state),refs:det.refs};
}

function execute(rows,p,memory,core){
  if(p&&p.action==='compare'&&p.compareItems){
    const cmp=comparisonDiagnostics(p.compareItems,rows,core);
    if(!cmp||cmp.items.length<2)return{ok:false,plan:p,rows:[],selected:null,entity:p.target,data:null,error:'No pude reconstruir los dos elementos a comparar.'};
    return{ok:true,plan:p,rows:core.filterRows(rows,p.filters||{}),selected:null,entity:p.target,data:{comparison:true,...cmp}};
  }
  if(p&&p.action==='aggregate'&&p.filters&&p.filters.operation){
    const rs=core.filterRows(rows,p.filters);
    if(!rs.length)return{ok:false,plan:p,rows:[],selected:null,entity:'operation',data:null,error:'No hay registros para ese alcance.'};
    const op=core.aggOps(rs).find(x=>norm(x.key)===norm(p.filters.operation));
    if(!op)return{ok:false,plan:p,rows:rs,selected:null,entity:'operation',data:null,error:'No encontré esa operación dentro del alcance seleccionado.'};
    const lineBreakdown=(op.lines||[]).map(line=>{
      const lr=rs.filter(r=>norm(r.linea)===norm(line));
      const lo=core.aggOps(lr).find(x=>norm(x.key)===norm(op.key));
      return lo?{line,hc:lo.hc,units:lo.units,sam:lo.sam,efficiency:lo.efficiency,orders:lo.orders?.length||0,styles:lo.styles?.length||0}:null;
    }).filter(Boolean).sort((a,b)=>core.num?core.num(b.hc)-core.num(a.hc):(Number(b.hc)||0)-(Number(a.hc)||0));
    const selected={operation:op.key,line:p.filters.line||(lineBreakdown.length===1?lineBreakdown[0].line:null),date:p.filters.date||(op.dates?.length===1?op.dates[0]:null),style:p.filters.style||(op.styles?.length===1?op.styles[0]:null),order:p.filters.order||(op.orders?.length===1?op.orders[0]:null)};
    return{ok:true,plan:p,rows:rs,selected,entity:'operation',data:{units:op.units,hc:op.hc,sam:op.sam,efficiency:op.efficiency,orders:op.orders?.length||0,styles:op.styles?.length||0,lines:op.lines?.length||0,lineNames:[...(op.lines||[])],lineBreakdown}};
  }
  if(p&&p.action==='aggregate'&&['sam','efficiency'].includes(p.metric)){
    const rs=core.filterRows(rows,p.filters||{});
    if(!rs.length)return{ok:false,plan:p,rows:[],selected:null,entity:p.target,data:null,error:'No hay registros para ese alcance.'};
    const ops=core.flatOps(rs),hcDen=ops.reduce((s,o)=>s+Math.max(Number(o.hc)||0,0),0);
    const efficiency=hcDen?ops.reduce((s,o)=>s+(Number(o.efficiency)||0)*Math.max(Number(o.hc)||0,0),0)/hcDen:0;
    const units=core.uniqueUnits?core.uniqueUnits(rs):rs.reduce((s,r)=>s+(Number(r.unidades)||0),0);
    const sam=units?rs.reduce((s,r)=>s+(Number(r.unidades)||0)*(r.operaciones||[]).reduce((z,o)=>z+(Number(o.sam)||0),0),0)/units:0;
    const base=core.execute(rows,{...p,metric:'hc'},memory||{});if(!base.ok)return base;
    base.plan=p;base.data={...base.data,sam,efficiency};return base;
  }
  return core.execute(rows,p,memory||{});
}

function classifyIntent(text,state){
  const n=norm(text);
  if(/\b(que pasa si|qué pasa si|y si|simula|simular|escenario|cambia|sube|baja|aumenta|reduce|agrega|agregar|quita|quitar|modifica|pon|pone|haz que)\b/.test(n))return'scenario';
  if(/\b(deshaz|deshacer|revierte|revertir|borra escenario|elimina escenario|reinicia escenario|vuelve al plan real|volver al plan real|restablece escenario)\b/.test(n))return'scenario_control';
  if(/\b(por que|por qué|porque|explica|explicame|explícame|causa|razon|razón|motivo|que provoca|qué provoca|a que se debe|a qué se debe)\b/.test(n))return'explain';
  if(/\b(compara|comparalo|compáralo|comparar|contra|versus|\bvs\b|diferencia)\b/.test(n))return'compare';
  if(/\b(analiza|analisis|análisis|recomienda|que harias|qué harías|prioridad|enfocarme|reforzar|refuerzo)\b/.test(n))return'analyze';
  return'query';
}

const TARGET_WORDS=[
  {key:'order',words:['orden','ordenes','órdenes']},
  {key:'style',words:['estilo','estilos']},
  {key:'operation',words:['operacion','operación','operaciones']},
  {key:'day',words:['dia','día','dias','días']},
  {key:'line',words:['linea','línea','lineas','líneas','familia','familias']}
];
function detectTarget(n){
  let strong=null,strongPos=Infinity;
  for(const t of TARGET_WORDS){
    for(const w of t.words){
      const reQ=new RegExp('\\b(que|cual|cuales|cuáles)\\s+(?:(?:es|son)\\s+)?(?:(?:el|la|los|las)\\s+)?'+w+'\\b');
      const reV=new RegExp('\\b'+w+'\\s+(tiene|requiere|pide|aporta|concentra|presenta|es|genera|representa|acumula)\\b');
      const m=n.match(reQ)||n.match(reV);
      if(m&&m.index<strongPos){strong=t.key;strongPos=m.index;}
    }
  }
  if(strong)return strong;
  let weak=null,weakPos=Infinity;
  for(const t of TARGET_WORDS){
    for(const w of t.words){
      const m=n.match(new RegExp('\\b'+w+'\\b'));
      if(m&&m.index<weakPos){weak=t.key;weakPos=m.index;}
    }
  }
  return weak;
}

function sanitizePlan(p,core){
  p=p&&typeof p==='object'?p:{};
  const pick=(v,a,d)=>a.includes(v)?v:d;
  return{
    action:pick(p.action,['aggregate','rank','group','detail','count','compare','analyze','explain','relationship','clarify'],'clarify'),
    target:pick(p.target,['area','line','order','style','operation','day'],'area'),
    metric:pick(p.metric,['units','hc','sam','efficiency','count','date','style','multi'],'multi'),
    groupBy:pick(p.groupBy,['none','date','line','order','style','operation'],'none'),
    criterion:pick(p.criterion,['none','max','min'],'none'),
    filters:{line:p.filters&&p.filters.line||null,date:p.filters&&p.filters.date||null,order:p.filters&&p.filters.order||null,style:p.filters&&p.filters.style||null,operation:p.filters&&p.filters.operation||null},
    output:pick(p.output,['brief','table','chart','analysis'],'brief'),
    compareDates:p.compareDates||null,
    compareItems:p.compareItems||null,
    requestedMetrics:Array.isArray(p.requestedMetrics)?p.requestedMetrics.filter(x=>['units','hc','sam','efficiency'].includes(x)):[],
    semanticMode:['critical','modifier','refinement','standard'].includes(p.semanticMode)?p.semanticMode:null,
    invalidLine:p.invalidLine||null
  };
}

function validateModelFilters(p,rows,core){
  const c=core.catalogs(rows);
  if(p.filters.line&&!c.lines.some(x=>norm(x)===norm(p.filters.line)))p.filters.line=null;
  if(p.filters.date&&!rows.some(r=>r.fecha===p.filters.date))p.filters.date=null;
  if(p.filters.order&&!c.orders.some(x=>norm(x)===norm(p.filters.order)))p.filters.order=null;
  if(p.filters.style&&!c.styles.includes(String(p.filters.style)))p.filters.style=null;
  if(p.filters.operation&&!c.operations.some(x=>norm(x)===norm(p.filters.operation)))p.filters.operation=null;
  return p;
}


function isCriticalConcept(n){
  return /\b(critica|criticas|critico|criticos|prioridad|prioridades|riesgo|riesgos)\b/.test(n);
}
function isMetricModifierTurn(text,state){
  const n=norm(text),tokens=n.split(' ').filter(Boolean);
  const metrics=requestedMetrics(text);
  if(!metrics.length||tokens.length>8)return false;
  if(detectTarget(n))return false;
  if(!state?.lastResult?.entity||!Array.isArray(state.lastResult.rows)||!state.lastResult.rows.length)return false;
  // A modifier changes the perspective of the immediately previous result.
  return /^(ahora|y ahora|ahora por|por|solo por|ordenalo por|ordenalos por|ordena por|segun|según|viendo|mirando)\b/.test(n)
    || /\b(ahora|esta vez|en cambio)\b/.test(n);
}
function applyModifierFrame(text,state,p){
  if(!isMetricModifierTurn(text,state))return false;
  const metric=requestedMetrics(text)[0];
  const last=state.lastResult;
  p.action='rank';p.target=last.entity;p.metric=metric;p.groupBy='none';p.output='table';
  p.filters={...(last.scope||{})};
  const key=last.entity==='day'?'date':last.entity;
  if(key&&Object.prototype.hasOwnProperty.call(p.filters,key))p.filters[key]=null;
  p.requestedMetrics=[metric];p.semanticMode='modifier';
  // When the prior frame was about criticality, efficiency-critical means lower configured efficiency.
  const critical=state.lastQuery?.semanticMode==='critical';
  p.criterion=(metric==='efficiency'&&critical)?'min':(state.lastQuery?.criterion&&state.lastQuery.criterion!=='none'?state.lastQuery.criterion:'max');
  return true;
}

function hasStrongAnalyticalRequest(n){
  // A strong request changes WHAT is being analysed, rather than merely WHERE.
  return /\b(que|cual|cuales|cuáles)\s+(orden|ordenes|estilo|estilos|operacion|operaciones|dia|dias|linea|lineas|familia|familias)\b/.test(n)
    || /\b(ranking|ordena|ordenar|compara|comparar|versus|vs|mayor|menor|maximo|minimo|pico|tendencia)\b/.test(n)
    || /\b(unidades|hc|sam|eficiencia|eficiencias)\b/.test(n);
}
function isScopeRefinementTurn(text,state,explicit){
  const n=norm(text);
  const lq=(state?.analysisFrame&&state.analysisFrame.action)?state.analysisFrame:state?.lastQuery;
  if(!lq||!lq.action||lq.action==='clarify')return false;
  const changed=!!(explicit?.line||explicit?.date||explicit?.order||explicit?.style||explicit?.operation);
  if(!changed)return false;
  // The user is narrowing/re-scoping the previous analytical object.
  const discourse=/\b(solo|solamente|unicamente|únicamente|ahora|esta vez|para|del dia|del día|en el dia|en el día|de ese dia|de ese día|haz el analisis|haz el análisis|mismo analisis|mismo análisis|ese analisis|ese análisis)\b/.test(n);
  if(!discourse)return false;
  // Explicit new analytical target/metric means a new request, not a refinement.
  if(hasStrongAnalyticalRequest(n)){
    // Generic word "analisis" is not a new analytical target.
    const stripped=n.replace(/\b(haz|el|la|un|una|analisis|análisis|solo|solamente|unicamente|únicamente|ahora|esta|vez|para|del|de|en|dia|día|lunes|martes|miercoles|miércoles|jueves|viernes|sabado|sábado|domingo)\b/g,' ').replace(/\s+/g,' ').trim();
    if(stripped)return false;
  }
  return true;
}
function applyScopeRefinementFrame(text,state,explicit,p){
  if(!isScopeRefinementTurn(text,state,explicit))return false;
  const prev=(state.analysisFrame&&state.analysisFrame.action)?state.analysisFrame:(state.lastQuery||{});
  p.action=prev.action||p.action;
  p.target=prev.target||p.target;
  p.metric=prev.metric||p.metric;
  p.groupBy=prev.groupBy||'none';
  p.criterion=prev.criterion||'none';
  p.output=prev.output||'table';
  p.requestedMetrics=[...(prev.requestedMetrics||[])];
  // 'refinement' is a continuation intent: the user is changing WHERE, not WHAT.
  p.semanticMode='refinement';
  p.filters={...(prev.filters||{})};
  // Apply only the new scope dimensions mentioned by the user.
  for(const k of SCOPE_KEYS)if(explicit&&explicit[k])p.filters[k]=explicit[k];
  // A grouping dimension must remain open; otherwise the previous breakdown collapses.
  const groupedKey=p.groupBy==='date'?'date':p.groupBy==='line'?'line':p.groupBy==='order'?'order':p.groupBy==='style'?'style':p.groupBy==='operation'?'operation':null;
  if(groupedKey&&!(explicit&&explicit[groupedKey]))p.filters[groupedKey]=null;
  return true;
}
function buildPlan(text,state,rows,core){
  const n=norm(text);
  const intent=classifyIntent(text,state);
  const e=explicitEntities(text,rows,core);
  const refs=resolveReferences(text,state,core);
  let p=sanitizePlan({},core);
  p.invalidLine=e.invalidLine||null;
  p.requestedMetrics=requestedMetrics(text);
  const ordinalPair=pairedOrdinalReference(text,state);

  const asksHC=/\b(hc|personal|personas|gente|recursos|headcount)\b/.test(n);
  const asksUnits=/\b(unidades|unidad|volumen|demanda|cantidad|programa|producir|planificad)\b/.test(n);
  const asksSAM=/\b(sam|complej|dificil|difícil|dificultad|tecnic|técnic)\b/.test(n);
  const asksEff=/\b(eficiencia|eficiente|ineficiente)\b/.test(n);
  const asksLoad=/\b(carga|cargado|cargada|presion|presión)\b/.test(n);
  const weeklyScope=/\b(semana|semanal|durante la semana|en la semana|toda la semana|semana completa)\b/.test(n);
  const detectedTarget=detectTarget(n);
  const explicitAllLines=/\b(todas las lineas|todas las líneas|todas las familias|area completa|área completa|programa completo|general)\b/.test(n);
  const globalLineQ=explicitAllLines||(detectedTarget==='line'&&/\b(mayor|menor|mas|más|maximo|máximo|minimo|mínimo|compar|ranking|todas|cargada|cargado)\b/.test(n)&&!e.line);
  const wantsAllOperations=/\b(todas las operaciones|todas operaciones|lista de operaciones|listado de operaciones|desglose de operaciones|despliegue de operaciones|detalle de operaciones|que operaciones|qué operaciones)\b/.test(n);
  const wantsByDay=/\b(por dia|por día|cada dia|cada día|despliegue por dia|despliegue por día|distribucion por dia|distribución por día)\b/.test(n);
  const broadScopeQ=/\b(area completa|área completa|programa completo|total del area|total del área|general)\b/.test(n);
  const criticalConcept=isCriticalConcept(n);

  p.metric=primaryMetric(text,p.requestedMetrics,state);
  if(p.metric==='multi'&&asksLoad)p.metric=state.scope.metric||'hc';

  if(/\b(menor|menos|minim|mas baja|más baja)\b/.test(n))p.criterion='min';
  if(/\b(mayor|mas|máximo|maximo|pico)\b/.test(n)&&p.criterion==='none')p.criterion='max';

  if(detectedTarget)p.target=detectedTarget;

  for(const k of SCOPE_KEYS)if(e[k])p.filters[k]=e[k];
  for(const k of Object.keys(refs.filters))if(!p.filters[k])p.filters[k]=refs.filters[k];

  // A possessive reference inherits the complete focus scope. This prevents
  // "su eficiencia" from becoming a line-level aggregate after an operation ranking.
  if(refs.possessiveApplied&&refs.referenceScope){
    for(const k of SCOPE_KEYS)if(!p.filters[k]&&refs.referenceScope[k])p.filters[k]=refs.referenceScope[k];
  }

  if(!p.filters.line&&!globalLineQ&&state.scope.line)p.filters.line=state.scope.line;
  if(!p.filters.date&&!weeklyScope&&!globalLineQ&&state.scope.date)p.filters.date=state.scope.date;
  if(!p.filters.order&&state.scope.order)p.filters.order=state.scope.order;
  if(!p.filters.style&&state.scope.style)p.filters.style=state.scope.style;
  if(!p.filters.operation&&state.scope.operation)p.filters.operation=state.scope.operation;

  // V29: una referencia como "¿en qué línea está esa operación y cuánto HC
  // requiere?" consulta PROPIEDADES de la operación enfocada. No debe
  // convertirse en una nueva búsqueda de línea ni perder el foco anterior.
  const asksOperationLocation=/\b(?:en\s+)?(?:que|cual)\s+lineas?\b/.test(n) &&
    /\b(esa operacion|esta operacion|dicha operacion|la operacion anterior|esa misma operacion)\b/.test(n);
  if(asksOperationLocation&&p.filters.operation){
    p.action='aggregate';p.target='operation';p.metric=asksHC?'hc':(p.metric==='multi'?'hc':p.metric);
    p.criterion='none';p.groupBy='none';p.output='brief';p.invalidLine=null;p.semanticMode='operation_locator';
    p=validateModelFilters(p,rows,core);
    return {plan:p,refs};
  }

  if(e.line){
    p.filters.line=e.line;
    if(!e.date)p.filters.date=null;
    p.filters.order=null;p.filters.style=null;
    // Keep an operation when the user explicitly mentioned both line and operation.
    if(!e.operation)p.filters.operation=null;
  }
  if(globalLineQ){p.filters.line=null;p.invalidLine=null;}
  if(weeklyScope)p.filters.date=null;
  if(broadScopeQ){p.filters.line=null;p.filters.date=null;p.filters.order=null;p.filters.style=null;p.filters.operation=null;}

  if(e.order){
    const rr=rows.find(r=>norm(r.orden)===norm(e.order));
    if(rr){p.filters.order=e.order;p.filters.line=rr.linea;p.filters.date=rr.fecha;p.filters.style=String(rr.estilo);}
  }
  if(e.style){p.filters.style=e.style;p.filters.order=null;p.filters.operation=null;}

  // V23.1: a scope-only follow-up keeps the previous analytical frame.
  // Example: "desglose de operaciones" -> "haz el análisis solo del día jueves"
  // remains an operation breakdown, now filtered to Thursday.
  if(applyScopeRefinementFrame(text,state,e,p)){
    p=validateModelFilters(p,rows,core);
    return {plan:p,refs};
  }

  // Discourse modifier: "ahora por eficiencias" changes the metric over the
  // immediately previous semantic set instead of starting a new unrelated query.
  if(applyModifierFrame(text,state,p)){
    p=validateModelFilters(p,rows,core);
    return {plan:p,refs};
  }

  // V28: "operacion critica" has a deterministic engineering meaning.
  // By default, critical = the operation with the highest HC required in the
  // active scope. If the user explicitly names another criterion, rank by that
  // criterion instead (SAM/units => max, efficiency => min). Never ask the user
  // to choose a criterion for this phrase; the agent must answer directly.
  if(criticalConcept&&p.target==='operation'&&p.requestedMetrics.length<=1){
    const explicitMetric=p.requestedMetrics[0]||'hc';
    p.action='rank';p.groupBy='none';p.target='operation';p.metric=explicitMetric;
    p.criterion=explicitMetric==='efficiency'?'min':'max';p.output='brief';
    p.filters.operation=null;p.semanticMode='critical';
    p=validateModelFilters(p,rows,core);
    return {plan:p,refs};
  }

  // Multi-dimensional criticality is not collapsed into one metric. We expose
  // both perspectives: workload pressure (HC high) and balance sensitivity
  // (configured efficiency low). No arbitrary combined score is invented.
  if(criticalConcept&&p.target==='operation'&&p.requestedMetrics.includes('hc')&&p.requestedMetrics.includes('efficiency')){
    p.action='group';p.groupBy='operation';p.metric='hc';p.criterion='none';p.output='analysis';
    p.filters.operation=null;p.semanticMode='critical';
    p=validateModelFilters(p,rows,core);
    return {plan:p,refs};
  }

  // A phrase such as "por que el primero requiere mas HC que el segundo"
  // is a comparison of the two rows just shown, not a generic area analysis.
  if(intent==='explain'&&ordinalPair){
    p.action='compare';p.output='analysis';p.target=ordinalPair.entity;
    p.metric=primaryMetric(text,p.requestedMetrics,state);
    if(p.metric==='multi')p.metric=ordinalPair.metric||'hc';
    p.compareItems=ordinalPair;
    p.filters={...ordinalPair.scope};
    return{plan:validateModelFilters(p,rows,core),refs};
  }
  if(intent==='explain'){
    p.action='explain';p.output='analysis';
    return{plan:validateModelFilters(p,rows,core),refs};
  }
  if(intent==='analyze'){
    p.action='analyze';p.output='analysis';
    return{plan:validateModelFilters(p,rows,core),refs};
  }

  const relationshipQ=/\b(es de|pertenece|corresponde a)\b/.test(n)&&(/orden/.test(n)||p.filters.order);
  const dateOfOrderQ=/\b(que dia|qué día|cuando esta|cuándo está|fecha)\b/.test(n)&&(/orden/.test(n)||p.filters.order);
  const styleOfOrderQ=/\bestilo\b/.test(n)&&(/\besa orden\b|\borden\b/.test(n)||p.filters.order)&&!asksHC&&!asksUnits&&!asksSAM;
  const compareDatesQ=intent==='compare'&&(e.dates||[]).length>=2;

  if(compareDatesQ){
    p.action='compare';p.output='analysis';p.compareDates=e.dates.slice(0,2);
    return{plan:validateModelFilters(p,rows,core),refs};
  }

  if(wantsAllOperations){
    p.action='group';p.groupBy='operation';p.target='operation';
    p.metric=asksSAM?'sam':asksEff?'efficiency':'hc';p.criterion='none';p.output='table';
    p.filters.operation=null;
  } else if(wantsByDay){
    p.action='group';p.groupBy='date';p.target='day';p.output='chart';p.criterion='none';
    if(!asksHC&&!asksUnits&&!asksSAM&&!asksEff)p.metric=state.scope.metric||p.metric||'units';
  } else if(styleOfOrderQ){
    p.action='detail';p.target='order';p.metric='style';p.output='brief';
  } else if(dateOfOrderQ){
    p.action='detail';p.target='order';p.metric='date';p.output='brief';
  } else if(relationshipQ){
    p.action='relationship';p.target='order';p.criterion='none';
  } else if(/\b(cuantas|cuántas)\s+(familias|lineas|líneas)\b/.test(n)){
    p.action='count';p.target='line';p.metric='count';p.filters.line=null;
  } else if(/\b(cuantas|cuántas)\s+(ordenes|órdenes)\b/.test(n)){
    p.action='count';p.target='order';p.metric='count';
  } else if(/\b(cuantos|cuántos)\s+estilos\b/.test(n)){
    p.action='count';p.target='style';p.metric='count';
  } else if(refs.ordinalApplied&&p.criterion==='none'&&p.metric==='multi'){
    const ent=refs.ordinalApplied.entity;
    p.action='aggregate';
    p.target=ent==='day'?'day':ent;
    p.metric=(state.lastResult&&state.lastResult.metric)||state.scope.metric||'units';
  } else if(p.criterion!=='none'&&['order','style','operation','line','day'].includes(p.target)){
    p.action='rank';
    if(p.target==='day')p.filters.date=null;
    if(p.target==='operation')p.filters.operation=null;
    if(p.target==='order')p.filters.order=null;
    if(p.target==='style')p.filters.style=null;
    if(p.target==='line')p.filters.line=null;
  } else if(p.metric!=='multi'&&(p.filters.line||p.filters.date||p.filters.order||p.filters.style||p.filters.operation)){
    p.action='aggregate';
    p.target=p.filters.operation?'operation':p.filters.style?'style':p.filters.order?'order':p.filters.line?'line':'area';
  } else {
    p.action='clarify';
  }

  if(p.metric==='multi'&&['aggregate','rank','group'].includes(p.action))p.metric='units';
  p=validateModelFilters(p,rows,core);
  return {plan:p,refs};
}

function validatePlan(text,plan,state){
  const intent=classifyIntent(text,state);
  const errors=[];
  if(intent==='explain'&&!['explain','analyze'].includes(plan.action)&&!(plan.action==='compare'&&plan.compareItems))errors.push('INTENT_EXPLAIN_LOST');
  if(intent==='compare'&&plan.action!=='compare')errors.push('INTENT_COMPARE_LOST');
  if(intent==='analyze'&&!['analyze','explain'].includes(plan.action))errors.push('INTENT_ANALYZE_LOST');
  return {ok:errors.length===0,intent,errors};
}

function reconcilePlanWithIntent(text,plan,state){
  // V24: a scope refinement already has a resolved semantic frame.
  // Words such as "analisis" in "haz el mismo analisis solo del jueves" describe
  // discourse continuity; they must NOT convert the inherited operation breakdown
  // into a new generic executive analysis.
  if(plan&&plan.semanticMode==='refinement')return plan;
  const v=validatePlan(text,plan,state);
  if(v.ok)return plan;
  if(v.errors.includes('INTENT_EXPLAIN_LOST')){plan.action='explain';plan.output='analysis';}
  if(v.errors.includes('INTENT_COMPARE_LOST'))plan.action='analyze';
  if(v.errors.includes('INTENT_ANALYZE_LOST')){plan.action='analyze';plan.output='analysis';}
  return plan;
}

function ambiguity(text,plan,refs,state,rows,core){
  const n=norm(text);

  if(plan.invalidLine){
    const c=core.catalogs(rows);
    return{title:`No encuentro la línea "${plan.invalidLine}" en esta semana.`,message:'Selecciona la línea que querías analizar:',
      choices:c.lines.map(x=>({label:x.replace(/^\d+\s*/,''),query:`En la línea ${x.replace(/^\d+\s*/,'')}: ${text}`}))};
  }

  if(refs.unresolved.length){
    const type=refs.unresolved[0];
    if(type==='date'){
      const dates=core.uniq(rows.map(r=>r.fecha)).sort();
      return{title:'No tengo un día activo en la conversación.',message:'Selecciona el día al que te refieres:',
        choices:dates.map(d=>({label:core.dayName(d),query:`Para el ${core.dayName(d)}: ${text}`}))};
    }
    if(type==='order'){
      const top=core.agg(rows,'order').sort((a,b)=>b.units-a.units).slice(0,5);
      return{title:'No hay una orden seleccionada todavía.',message:'¿Te refieres a alguna de estas órdenes?',
        choices:top.map(x=>({label:`${x.key} · ${core.fmt(x.units)} un.`,query:`Sobre la orden ${x.key}: ${text}`}))};
    }
    return{title:'Necesito una referencia más clara.',message:`Mencionaste "${type}" pero no tengo ese dato activo en la conversación.`,choices:[]};
  }

  const deterministicCriticalOperation=/\boperacion\s+critica\b/.test(n);
  const loadAmb=/\b(carga|cargado|cargada|pesada|pesado|critica|crítica)\b/.test(n)
    &&!deterministicCriticalOperation
    &&!(/\b(hc|personal|personas|unidades|volumen|demanda|sam|complejidad|eficiencia)\b/.test(n))
    &&!state.scope.metric;
  if(loadAmb&&!/\b(porque|por que|por qué|analiza|prioridad|recomienda)\b/.test(n)){
    return{title:'¿Con qué criterio quieres medirlo?',message:'Puedo interpretar esa pregunta de varias formas.',choices:[
      {label:'HC requerido',query:`Usando HC requerido: ${text}`},
      {label:'Unidades programadas',query:`Usando unidades programadas: ${text}`},
      {label:'Complejidad por SAM',query:`Usando SAM: ${text}`}
    ]};
  }

  const genericOpen=/^(dame|muestra|muestrame|muéstrame|quiero ver|haz|hazme)?\s*(el |la |un |una )?(detalle|despliegue|desglose|resumen|analisis|análisis|informacion|información|que hay|qué hay|como esta|cómo está|revisa)(\s+(de|sobre)\s+(eso|esto|esa|ese))?\s*$/.test(n);
  const unresolved=plan.action==='clarify';
  if(genericOpen||unresolved){
    const f=state.focus||{};
    const scopeName=f.entity==='operation'?`la operación ${f.value}`:f.entity==='order'?`la orden ${f.value}`:f.entity==='style'?`el estilo ${f.value}`:state.scope.line?`la línea ${state.scope.line.replace(/^\d+\s*/,'')}`:'el área activa';
    const prefix=f.entity?`Para ${scopeName}`:'';
    return{title:`¿Qué quieres ver de ${scopeName}?`,message:'La pregunta admite varias interpretaciones. Elige una opción.',choices:[
      {label:'Unidades por día',query:`${prefix}, muéstrame las unidades planificadas por día`.trim()},
      {label:'HC por día',query:`${prefix}, muéstrame el HC requerido por día`.trim()},
      {label:'Operaciones por HC',query:`${prefix}, dame el despliegue de operaciones por HC`.trim()},
      {label:'Órdenes por unidades',query:`${prefix}, dame las unidades por orden`.trim()}
    ]};
  }
  return null;
}

function updateState(state,plan,result){
  const s=cloneState(state);

  if(result&&result.errorCode==='INVALID_LINE'){
    s.scope.line=null;s.scope.order=null;s.scope.style=null;s.scope.operation=null;
    if(plan.filters&&plan.filters.date)s.scope.date=plan.filters.date;
    return s;
  }

  if(plan.target==='line'&&plan.filters.line&&norm(plan.filters.line)!==norm(s.scope.line||'')){
    s.scope.order=null;s.scope.style=null;s.scope.operation=null;
  }
  if(plan.action==='group'&&plan.groupBy==='operation'){s.scope.operation=null;}
  if(plan.action==='group'&&plan.groupBy==='order'){s.scope.order=null;}

  for(const k of SCOPE_KEYS)if(plan.filters&&plan.filters[k])s.scope[k]=plan.filters[k];
  if(plan.metric&&plan.metric!=='multi')s.scope.metric=plan.metric;
  s.lastQuery={
    action:plan.action||null,target:plan.target||null,metric:plan.metric||null,groupBy:plan.groupBy||'none',criterion:plan.criterion||null,
    output:plan.output||'brief',requestedMetrics:[...(plan.requestedMetrics||[])],semanticMode:plan.semanticMode||null,filters:{...(plan.filters||{})}
  };

  // Canonical analytical memory. Keep the shape of the last successful analysis
  // separately from transient focus/result state. A later scope-only turn can
  // therefore reuse the exact action/target/metric/grouping/output.
  if(plan.action&&plan.action!=='clarify'){
    s.analysisFrame={
      action:plan.action||null,target:plan.target||null,metric:plan.metric||null,groupBy:plan.groupBy||'none',criterion:plan.criterion||null,
      output:plan.output||'brief',requestedMetrics:[...(plan.requestedMetrics||[])],semanticMode:plan.semanticMode||null,filters:{...(plan.filters||{})}
    };
  }

  if(!result)return s;

  if(['rank','group'].includes(plan.action)&&Array.isArray(result.data)){
    s.lastResult={entity:result.entity,rows:result.data.slice(0,10),metric:plan.metric,scope:{...s.scope},kind:plan.action};
  }

  if(plan.action==='detail'&&plan.target==='order'&&plan.metric==='style'&&result.data&&result.data.styles&&result.data.styles[0]){
    const st=result.data.styles[0];
    s.scope.style=st;
    s.focus={entity:'style',value:st,scope:{...s.scope,style:st}};
  } else if(result.selected&&result.entity){
    const value=result.selected[result.entity]||result.selected.key||result.selected.date||null;
    s.focus={entity:result.entity,value,scope:{...s.scope,...result.selected}};
  } else if(result.entity&&result.data&&!Array.isArray(result.data)){
    const focusKey=plan.target==='day'?'date':plan.target;
    const filterVal=plan.filters&&plan.filters[focusKey];
    if(plan.action==='detail'&&plan.target==='order'&&plan.filters.order){
      s.focus={entity:'order',value:plan.filters.order,scope:{...s.scope}};
    } else if(filterVal){
      s.focus={entity:plan.target,value:filterVal,scope:{...s.scope}};
    }
  }
  return s;
}


/* ============================================================
   V19 — POLITICA TRANSACCIONAL DE ESCENARIOS
   Un nuevo What-If reemplaza el escenario anterior por defecto.
   Solo se acumula cuando el usuario lo pide explicitamente.
   ============================================================ */

function scenarioEditIntent(text,existingChanges=[]){
  const n=norm(text);
  if(!Array.isArray(existingChanges)||!existingChanges.length)return null;
  // Interpret scenario-management requests semantically: remove/keep existing assumptions
  // without demanding a new numeric value.
  const removeWords=/\b(quita|quitar|elimina|eliminar|borra|borrar|remueve|remover|descarta|descartar|deshaz|deshacer)\b/;
  const keepWords=/\b(deja|dejar|mantiene|mantener|manten|conserva|conservar|solo|solamente|unicamente|únicamente)\b/;
  const types=[];
  if(/\b(horas?|tiempo|turno)\b/.test(n))types.push('hours');
  if(/\b(eficiencia|rendimiento)\b/.test(n))types.push('efficiency');
  if(/\b(unidades?|volumen|demanda)\b/.test(n))types.push('units');
  if(/\bsam\b/.test(n))types.push('sam');
  const remove=removeWords.test(n);
  const keep=keepWords.test(n);
  if(remove&&types.length){
    // When sentence says “quita X y deja Y”, X is the first typed concept after a remove verb.
    let removeTypes=[];
    const rm=n.match(/(?:quita|quitar|elimina|eliminar|borra|borrar|remueve|remover|descarta|descartar|deshaz|deshacer)([\s\S]{0,120}?)(?=\b(?:y|pero)\s+(?:deja|mantiene|manten|conserva)|[.;,]|$)/);
    const seg=rm?rm[0]:n;
    if(/\b(horas?|tiempo|turno)\b/.test(seg))removeTypes.push('hours');
    if(/\b(eficiencia|rendimiento)\b/.test(seg))removeTypes.push('efficiency');
    if(/\b(unidades?|volumen|demanda)\b/.test(seg))removeTypes.push('units');
    if(/\bsam\b/.test(seg))removeTypes.push('sam');
    if(!removeTypes.length)removeTypes=[types[0]];
    return {kind:'remove_types',types:[...new Set(removeTypes)]};
  }
  if(keep&&types.length&&/\b(solo|solamente|unicamente|únicamente)\b/.test(n)){
    return {kind:'keep_types',types:[...new Set(types)]};
  }
  return null;
}

function scenarioContinuationMode(text,hasActive=false,existingChanges=[],newChange=null){
  const n=norm(text);
  if(!hasActive)return 'replace';
  const explicitAppend=/\b(ademas|tambien|manteniendo|mantener|manten|mantiene|conservando|conservar|conserva|sin quitar|sin eliminar|junto con|sumado a|sobre ese escenario|sobre este escenario|en ese escenario|en este escenario|combina|combinalo|acumula|agrega tambien|anade tambien|y ademas)\b/.test(n);
  if(explicitAppend)return 'append';
  // Mantiene la política histórica de reemplazo por defecto. Solo tratamos como
  // refinamiento compuesto una frase que explícitamente dice "ahora" y pide
  // comparar el NUEVO resultado contra el escenario original/base.
  const compoundRefinement=/^(ahora|y ahora)\b/.test(n)&&
    /\b(compara|comparame|comparalo|contra|versus|vs)\b/.test(n)&&
    /\b(original|base|real|plan base)\b/.test(n);
  const last=Array.isArray(existingChanges)&&existingChanges.length?existingChanges[existingChanges.length-1]:null;
  if(compoundRefinement&&last&&newChange&&last.type!==newChange.type)return 'append';
  return 'replace';
}
function scenarioTransaction(text,state,rows,core,existingChanges=[]){
  // V38: los escenarios activos también son memoria contextual. Una continuación
  // como "esa misma línea", "conserva ese cambio" o "ahora mejora..."
  // debe poder heredar el alcance del último What-If aunque el análisis normal
  // no tenga una línea/operación enfocada en ese instante.
  const active=Array.isArray(existingChanges)&&existingChanges.length>0;
  const last=active?existingChanges[existingChanges.length-1]:null;
  let txState=state;
  if(last&&last.scope){
    txState=cloneState(state);
    txState.scope={...(last.scope||{}),...(state&&state.scope||{})};
    // Los valores no vacíos del escenario son contexto válido de respaldo.
    for(const k of SCOPE_KEYS){
      if(!(txState.scope&&txState.scope[k])&&last.scope[k])txState.scope[k]=last.scope[k];
    }
    // Si el usuario se refiere explícitamente a la misma línea, la línea es el
    // objeto del cambio. No exigimos una operación para cambios de eficiencia:
    // aplicar eficiencia a una línea significa ajustar todas sus operaciones
    // dentro del alcance temporal heredado.
    const n=norm(text);
    if(/\b(esa misma linea|esa linea|la misma linea)\b/.test(n)&&last.scope.line){
      txState.scope.line=last.scope.line;
      if(!/\b(operacion|esa operacion|misma operacion)\b/.test(n))txState.scope.operation=null;
    }
  }
  const parsed=parseScenarioChange(text,txState,rows,core);
  if(!parsed.ok)return parsed;
  const mode=scenarioContinuationMode(text,active,existingChanges,parsed.change);
  return {...parsed,mode};
}

function scenarioNumericDirection(n){
  // Relative language is semantic, not tied to one command verb.
  // "una hora menos", "5 puntos menos" and "0.05 menos de SAM" are deltas.
  if(/\b(baja|bajar|reduce|reducir|disminuye|disminuir|quita|quitar|resta|restar|menos)\b/.test(n))return 'subtract';
  if(/\b(mejora|mejorar|sube|subir|aumenta|aumentar|incrementa|incrementar|agrega|agregar|suma|sumar|anade|añade|mas|más)\b/.test(n))return 'add';
  return 'set';
}
function scenarioNumberTokenValue(token){
  if(token==null)return null;
  const t=String(token).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(',','.').trim();
  if(/^\d+(?:\.\d+)?$/.test(t))return Number(t);
  const words={un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,media:0.5,medio:0.5};
  return Object.prototype.hasOwnProperty.call(words,t)?words[t]:null;
}
function scenarioPlainNumber(text){
  // Fallback only. Typed variables should use scenarioQuantityForType so IDs,
  // dates or earlier quantities do not steal the value from the intended metric.
  const raw=String(text||'').replace(/,/g,'.');
  const m=raw.match(/\b(\d+(?:\.\d+)?)\b/);
  if(m)return Number(m[1]);
  const n=norm(text);
  const words={un:1,uno:1,una:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,media:0.5,medio:0.5};
  for(const [w,v] of Object.entries(words))if(new RegExp(`\\b${w}\\b`).test(n))return v;
  return null;
}
function scenarioHourPhraseValue(text){
  const n=String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/,/g,'.').replace(/[^a-z0-9.]+/g,' ').replace(/\s+/g,' ').trim();
  const word='(?:\\d+(?:\\.\\d+)?|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)';
  const tokenValue=t=>scenarioNumberTokenValue(t);
  const matches=[];
  function push(value,index,weight=120){if(Number.isFinite(value))matches.push({value,index,weight});}
  let m;

  // Compound durations are parsed as a single semantic quantity. This prevents
  // "una hora y media" from being truncated to only "una hora" (= 1.0).
  const compound=new RegExp(`\\b(${word})\\s*horas?\\s*(?:y|con)\\s*(media|medio|cuarto)\\b`,'g');
  while((m=compound.exec(n))){
    const base=tokenValue(m[1]);
    const frac=/cuarto/.test(m[2])?0.25:0.5;
    push(base+frac,m.index,160);
  }
  const implicit=/\bhora\s*(?:y|con)\s*(media|medio|cuarto)\b/g;
  while((m=implicit.exec(n)))push(1+(/cuarto/.test(m[1])?0.25:0.5),m.index,155);

  const hourMinutes=new RegExp(`\\b(${word})\\s*horas?\\s*(?:y|con)?\\s*(\\d+(?:\\.\\d+)?)\\s*minutos?\\b`,'g');
  while((m=hourMinutes.exec(n))){
    const base=tokenValue(m[1]), mins=Number(m[2]);
    if(base!=null&&mins>=0&&mins<60)push(base+mins/60,m.index,150);
  }
  const compact=/\b(\d+(?:\.\d+)?)\s*h(?:oras?)?\s*(\d+(?:\.\d+)?)\s*m(?:in(?:utos?)?)?\b/g;
  while((m=compact.exec(n))){
    const base=Number(m[1]), mins=Number(m[2]);
    if(mins>=0&&mins<60)push(base+mins/60,m.index,145);
  }
  const minutes=/\b(\d+(?:\.\d+)?)\s*minutos?\b/g;
  while((m=minutes.exec(n)))push(Number(m[1])/60,m.index,110);
  const threeQuarters=/\b(?:tres\s+cuartos(?:\s+de)?\s+hora)\b/g;
  while((m=threeQuarters.exec(n)))push(0.75,m.index,150);

  if(!matches.length)return null;
  matches.sort((a,b)=>a.weight-b.weight||a.index-b.index);
  return matches[matches.length-1].value;
}
function scenarioQuantityForType(text,type,absoluteTarget=false){
  const n=String(text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/,/g,'.').replace(/[^a-z0-9.]+/g,' ').trim();
  const num='(?:\\d+(?:\\.\\d+)?|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|media|medio)';
  const candidates=[];
  if(type==='hours'){
    const phrase=scenarioHourPhraseValue(text);
    if(phrase!=null)candidates.push({value:phrase,index:Number.MAX_SAFE_INTEGER,weight:200});
  }
  function collect(re,group=1,weight=10){
    let m; while((m=re.exec(n))){
      const value=scenarioNumberTokenValue(m[group]);
      if(value!=null)candidates.push({value,index:m.index,weight});
      if(!re.global)break;
    }
  }
  // Absolute targets bind to the number introduced by a/hasta/en. This avoids
  // confusing a baseline mentioned earlier in the sentence with the new target.
  if(absoluteTarget){
    if(type==='hours')collect(new RegExp(`\\b(?:a|hasta|en)\\s+(${num})\\s*(?:horas?)?\\b`,'g'),1,100);
    if(type==='units')collect(new RegExp(`\\b(?:a|hasta|en)\\s+(${num})\\s*(?:unidades?)?\\b`,'g'),1,100);
    if(type==='sam')collect(new RegExp(`\\b(?:a|hasta|en)\\s+(${num})\\s*(?:de\\s+)?sam\\b`,'g'),1,100);
  }
  if(type==='hours'){
    collect(new RegExp(`\\b(${num})\\s*horas?\\b`,'g'),1,70);
    collect(new RegExp(`\\bhoras?\\s*(?:de|a|en|=)?\\s*(${num})\\b`,'g'),1,60);
  } else if(type==='units'){
    collect(new RegExp(`\\b(${num})\\s*unidades?\\b`,'g'),1,70);
    collect(new RegExp(`\\bunidades?\\s*(?:de|a|en|=)?\\s*(${num})\\b`,'g'),1,60);
  } else if(type==='sam'){
    collect(new RegExp(`\\b(${num})\\s*(?:de\\s+)?sam\\b`,'g'),1,70);
    collect(new RegExp(`\\bsam\\s*(?:de|a|en|=)?\\s*(${num})\\b`,'g'),1,70);
  }
  if(!candidates.length)return scenarioPlainNumber(text);
  // Strongest variable binding wins. If two equally valid quantities occur,
  // the later one is the active reformulation: "en vez de una, dos horas menos".
  candidates.sort((a,b)=>a.weight-b.weight||a.index-b.index);
  return candidates[candidates.length-1].value;
}
function scenarioExplicitAbsoluteTarget(n){
  return /\b(a|hasta)\s+\d/.test(n)||/\b(cambia|cambiar|pon|poner|pone|fija|fijar|establece|establecer|deja|dejar)\b[^\d]{0,25}\b(a|en)?\s*\d/.test(n);
}
function scenarioRelativeBounds(type,scope,delta,mode,rows){
  if(!['add','subtract'].includes(mode))return null;
  const targets=scenarioRowsForScope(rows,scope,type==='efficiency'||type==='sam');
  if(!targets.length)return null;
  const sign=mode==='add'?1:-1;
  if(type==='efficiency'){
    const vals=[];
    for(const r of targets)for(const o of(r.operaciones||[])){
      if(scope.operation&&o.operacion!==scope.operation)continue;
      let e=Number(o.eficiencia); if(e>1)e/=100;
      if(Number.isFinite(e))vals.push(e+sign*delta);
    }
    if(vals.some(v=>v<=0||v>1.5))return 'El cambio relativo de eficiencia dejaría un valor fuera de rango. Indica un valor final válido.';
  }
  if(type==='hours'){
    const vals=targets.map(r=>(Number(r.horas)||1)+sign*delta);
    if(vals.some(v=>v<=0||v>24))return 'El cambio relativo de horas dejaría un valor fuera de rango. Indica horas válidas para el turno.';
  }
  if(type==='sam'){
    const vals=[];
    for(const r of targets)for(const o of(r.operaciones||[])){
      if(scope.operation&&o.operacion!==scope.operation)continue;
      const s=Number(o.sam)||0;
      vals.push(s+sign*delta);
    }
    if(vals.some(v=>v<=0))return 'El cambio relativo de SAM dejaría un valor no válido. Indica un SAM positivo.';
  }
  return null;
}
function scenarioResolveSuperlativeScope(text,scope,rows,core){
  const n=norm(text);
  const target=/\blineas?\b/.test(n)?'line':/\boperacion(?:es)?\b/.test(n)?'operation':/\borden(?:es)?\b/.test(n)?'order':/\bestilos?\b/.test(n)?'style':/\b(?:dias?|fechas?)\b/.test(n)?'day':null;
  if(!target)return null;
  const superlative=/\b(mayor|mas alto|mas alta|maximo|maxima|pico|lider|menor|mas bajo|mas baja|minimo|minima)\b/.test(n);
  if(!superlative)return null;
  const criterion=/\b(menor|mas bajo|mas baja|minimo|minima)\b/.test(n)?'min':'max';
  const metric=/\bunidades?|volumen|demanda|cantidad\b/.test(n)?'units':/\bsam|complejidad\b/.test(n)?'sam':/\beficiencia\b/.test(n)?'efficiency':'hc';
  const baseScope={...(scope||{})};
  if(target==='line')baseScope.line=null;
  if(target==='operation')baseScope.operation=null;
  if(target==='order')baseScope.order=null;
  if(target==='style')baseScope.style=null;
  if(target==='day')baseScope.date=null;
  const base=scenarioRowsForScope(rows,baseScope,!!baseScope.operation);
  if(!base.length)return null;
  let candidates=[];
  if(target==='operation'){
    candidates=(core.aggOps?core.aggOps(base):[]).map(x=>({key:x.key,hc:Number(x.hc)||0,units:Number(x.units)||0,sam:Number(x.sam)||0,efficiency:Number(x.efficiency)||0}));
  }else{
    const entity=target==='day'?'day':target;
    const grouped=core.agg?core.agg(base,entity):[];
    candidates=grouped.map(x=>{
      const key=x.key;
      let subset=base;
      if(target==='line')subset=base.filter(r=>r.linea===key);
      else if(target==='order')subset=base.filter(r=>r.orden===key);
      else if(target==='style')subset=base.filter(r=>String(r.estilo)===String(key));
      else if(target==='day')subset=base.filter(r=>String(r.fecha).slice(0,10)===String(key).slice(0,10));
      const ops=core.flatOps?core.flatOps(subset):[];
      const hc=Number(x.hc)||0,units=Number(x.units)||0;
      const samDen=ops.reduce((z,o)=>z+Math.max(Number(o.units)||0,0),0);
      const sam=samDen?ops.reduce((z,o)=>z+(Number(o.sam)||0)*Math.max(Number(o.units)||0,0),0)/samDen:0;
      const effDen=ops.reduce((z,o)=>z+Math.max(Number(o.hc)||0,0),0);
      const efficiency=effDen?ops.reduce((z,o)=>z+(Number(o.efficiency)||0)*Math.max(Number(o.hc)||0,0),0)/effDen:0;
      return{key,hc,units,sam,efficiency};
    });
  }
  if(!candidates.length)return null;
  const score=x=>Number(x[metric])||0;
  candidates.sort((a,b)=>criterion==='min'?score(a)-score(b):score(b)-score(a));
  const winner=candidates[0];
  if(!winner||winner.key==null)return null;
  if(target==='line')scope.line=winner.key;
  else if(target==='operation')scope.operation=winner.key;
  else if(target==='order')scope.order=winner.key;
  else if(target==='style')scope.style=String(winner.key);
  else if(target==='day')scope.date=winner.key;
  return{target,metric,criterion,value:winner.key,score:score(winner),candidates};
}

function parseScenarioChange(text,state,rows,core){
  const n=norm(text);
  const e=explicitEntities(text,rows,core);
  const refs=resolveReferences(text,state,core);
  const refScope=refs.referenceScope||{};
  const scope={
    line:e.line||refs.filters.line||refScope.line||state.scope.line||null,
    date:e.date||refs.filters.date||refScope.date||state.scope.date||null,
    order:e.order||refs.filters.order||refScope.order||state.scope.order||null,
    style:e.style||refs.filters.style||refScope.style||state.scope.style||null,
    operation:e.operation||refs.filters.operation||refScope.operation||state.scope.operation||null
  };
  // V39: referencias descriptivas como 'la línea con mayor HC' se resuelven
  // contra los datos reales del alcance ANTES de aplicar el What-If.
  // Así el escenario nunca cae accidentalmente al área completa.
  const superlativeScope=scenarioResolveSuperlativeScope(text,scope,rows,core);

  const effMatch=text.match(/(\d+(?:\.\d+)?)\s*%/);
  const pointMatch=n.match(/\b(\d+(?:\.\d+)?)\s*(?:puntos?\s+porcentuales?|puntos?|pp)\b/);
  const numValue=scenarioPlainNumber(text);
  const direction=scenarioNumericDirection(n);
  const absoluteTarget=scenarioExplicitAbsoluteTarget(n);

  const isEfficiency=/\beficiencia\b/.test(n)||(effMatch&&/\b(sube|baja|aumenta|reduce|cambia|pon|pone)\b/.test(n)&&!/\bunidades\b/.test(n));
  const isHours=/\b(?:horas?|minutos?)\b/.test(n)||/\b\d+(?:\.\d+)?\s*h(?:oras?)?\s*\d+(?:\.\d+)?\s*m(?:in(?:utos?)?)?\b/.test(n);
  const isUnits=/\bunidades\b/.test(n)&&!isEfficiency;
  const isSam=/\bsam\b/.test(n);

  if(refs.unresolved.length){
    return{ok:false,needsClarification:true,reason:`No pude resolver la referencia "${refs.unresolved[0]}" para construir el escenario.`};
  }

  if(isEfficiency){
    // "baja/sube 5 puntos" = variación en PUNTOS PORCENTUALES, no eficiencia final de 5%.
    if(pointMatch&&direction!=='set'&&!absoluteTarget){
      const value=Number(pointMatch[1])/100;
      const err=scenarioRelativeBounds('efficiency',scope,value,direction,rows);
      if(err)return{ok:false,needsClarification:true,reason:err};
      return{ok:true,change:{type:'efficiency',scope,value,mode:direction,unit:'percentage_points'}};
    }

    // "sube/baja 5%" es semánticamente ambiguo: puede significar 5 puntos o 5% relativo.
    if(effMatch&&direction!=='set'&&!absoluteTarget&&!/\bpuntos?\b/.test(n)){
      return{ok:false,needsClarification:true,reason:`“${direction==='add'?'Subir':'Bajar'} ${effMatch[1]}%” es ambiguo. Indica “${direction==='add'?'sube':'baja'} ${effMatch[1]} puntos” para variar puntos porcentuales, o “${direction==='add'?'sube':'baja'} a ${effMatch[1]}%” para fijar la eficiencia final.`};
    }

    let value=effMatch?Number(effMatch[1])/100:numValue;
    if(value==null)return{ok:false,needsClarification:true,reason:'¿A qué porcentaje de eficiencia quieres simular el cambio?'};
    if(value>1)value=value/100;
    // Sin "puntos" y con objetivo explícito, se interpreta como valor FINAL.
    return{ok:true,change:{type:'efficiency',scope,value,mode:'set',unit:'ratio'}};
  }
  if(isHours){
    const value=scenarioQuantityForType(text,'hours',absoluteTarget);
    if(value==null)return{ok:false,needsClarification:true,reason:'¿Cuántas horas quieres simular? Puedes indicar un valor final (por ejemplo, 7 horas) o un cambio relativo (por ejemplo, una hora menos).'};
    const mode=(direction!=='set'&&!absoluteTarget)?direction:'set';
    const err=scenarioRelativeBounds('hours',scope,value,mode,rows);
    if(err)return{ok:false,needsClarification:true,reason:err};
    return{ok:true,change:{type:'hours',scope,value,mode}};
  }
  if(isSam){
    const value=scenarioQuantityForType(text,'sam',absoluteTarget);
    if(value==null)return{ok:false,needsClarification:true,reason:'¿A qué valor de SAM quieres simular el cambio?'};
    const mode=(direction!=='set'&&!absoluteTarget)?direction:'set';
    const err=scenarioRelativeBounds('sam',scope,value,mode,rows);
    if(err)return{ok:false,needsClarification:true,reason:err};
    return{ok:true,change:{type:'sam',scope,value,mode}};
  }
  if(isUnits){
    const value=scenarioQuantityForType(text,'units',absoluteTarget);
    if(value==null)return{ok:false,needsClarification:true,reason:'¿Cuántas unidades quieres simular?'};
    const mode=/\b(mas|más|extra|extras|adicional|adicionales|agrega|agregar|suma|sumar|anade|añade|incrementa|aumenta)\b/.test(n)?'add'
      :/\b(menos|quita|quitar|reduce|reducir|disminuye|resta)\b/.test(n)?'subtract':'set';
    return{ok:true,change:{type:'units',scope,value,mode}};
  }
  return{ok:false,needsClarification:true,reason:'No reconocí qué variable quieres simular (eficiencia, horas, unidades o SAM).'};
}

function scenarioRowsForScope(baseRows,scope,includeOperation){
  return baseRows.filter(r=>
    (!scope.date||String(r.fecha).slice(0,10)===String(scope.date).slice(0,10))&&
    (!scope.line||r.linea===scope.line)&&
    (!scope.order||r.orden===scope.order)&&
    (!scope.style||String(r.estilo)===String(scope.style))&&
    (!includeOperation||!scope.operation||(r.operaciones||[]).some(o=>o.operacion===scope.operation))
  );
}
function scenarioRecalcRow(r){r.hc=(r.operaciones||[]).reduce((s,o)=>s+(Number(o.hc)||0),0);return r;}
function scenarioUniqueUnits(rs){const m=new Map();for(const r of rs||[]){const k=[String(r.fecha||'').slice(0,10),norm(r.linea),norm(r.orden),String(r.estilo||'')].join('|'),u=Number(r.unidades)||0;if(!m.has(k)||u>m.get(k))m.set(k,u)}return [...m.values()].reduce((s,u)=>s+u,0)}

// V21: summary at the semantic scope. If the scope contains an operation,
// HC/SAM/efficiency are calculated ONLY for that operation, never for the whole row/line.
function scenarioSummaryForScope(baseRows,scope,core){
  scope=scope||{};
  const rs=scenarioRowsForScope(baseRows,scope,!!scope.operation);
  if(!scope.operation){
    const days=core.agg(rs,'day').map(d=>({...d,unidades:Number(d.unidades??d.units??0)||0,units:Number(d.units??d.unidades??0)||0}));
    const ops=core.flatOps(rs);
    const hcDen=ops.reduce((z,o)=>z+Math.max(Number(o.hc)||0,0),0);
    const eff=hcDen?ops.reduce((z,o)=>{let e=Number(o.efficiency??o.eficiencia)||0;if(e<=1)e*=100;return z+e*Math.max(Number(o.hc)||0,0)},0)/hcDen:0;
    return{units:core.uniqueUnits?core.uniqueUnits(rs):rs.reduce((z,r)=>z+(Number(r.unidades)||0),0),hc:days.reduce((z,d)=>z+(Number(d.hc)||0),0),avgHC:days.length?days.reduce((z,d)=>z+(Number(d.hc)||0),0)/days.length:0,peakHC:days.length?Math.max(...days.map(d=>Number(d.hc)||0)):0,days,efficiency:eff,sam:0};
  }
  const byDay=new Map();
  let units=0,hc=0,effNum=0,effDen=0,samNum=0,samUnits=0;
  for(const r of rs){
    const op=(r.operaciones||[]).find(o=>norm(o.operacion)===norm(scope.operation));
    if(!op)continue;
    const u=Number(r.unidades)||0,oh=Number(op.hc)||0,os=Number(op.sam)||0;
    let oe=Number(op.eficiencia??op.efficiency)||0;if(oe<=1)oe*=100;
    units+=u;hc+=oh;effNum+=oe*Math.max(oh,0);effDen+=Math.max(oh,0);samNum+=os*u;samUnits+=u;
    const key=String(r.fecha).slice(0,10),cur=byDay.get(key)||{key,label:core.dayName?core.dayName(key):key,unidades:0,units:0,hc:0,effNum:0,effDen:0,samNum:0,samUnits:0};
    cur.unidades+=u;cur.units+=u;cur.hc+=oh;cur.effNum+=oe*Math.max(oh,0);cur.effDen+=Math.max(oh,0);cur.samNum+=os*u;cur.samUnits+=u;byDay.set(key,cur);
  }
  const days=[...byDay.values()].sort((a,b)=>a.key.localeCompare(b.key)).map(d=>({...d,efficiency:d.effDen?d.effNum/d.effDen:0,sam:d.samUnits?d.samNum/d.samUnits:0}));
  return{units,hc,avgHC:days.length?hc/days.length:0,peakHC:days.length?Math.max(...days.map(d=>d.hc)):0,days,efficiency:effDen?effNum/effDen:0,sam:samUnits?samNum/samUnits:0};
}


/* ============================================================
   V22 — COMPARADOR SEMANTICO DE ESCENARIOS
   Una comparación Plan base vs Simulado es una intención propia,
   no una variante de "mostrar escenario". El motor devuelve un
   snapshot tipado de métricas dentro del MISMO alcance del cambio.
   ============================================================ */
function scenarioComparisonSnapshot(baseRows,changes,text,core){
  if(!Array.isArray(changes)||!changes.length)return{ok:false,error:'No hay un escenario activo para comparar.'};
  const last=changes[changes.length-1],scope={...(last.scope||{})};
  const simRows=applyScenario(baseRows,changes);
  const base=scenarioSummaryForScope(baseRows,scope,core);
  const simulated=scenarioSummaryForScope(simRows,scope,core);
  let metrics=requestedMetrics(text).filter(x=>['hc','units','efficiency','sam'].includes(x));
  // If the user only says "compare it", choose the metric changed plus HC impact.
  if(!metrics.length){
    const changed=last.type==='units'?'units':last.type==='efficiency'?'efficiency':last.type==='sam'?'sam':null;
    metrics=[...(changed?[changed]:[]),'hc'];
  }
  // HC is the capacity consequence of efficiency/SAM/units changes, so include it
  // unless the user explicitly asks only for a different metric.
  if((metrics.includes('efficiency')||metrics.includes('sam')||metrics.includes('units'))&&!metrics.includes('hc'))metrics.push('hc');
  metrics=[...new Set(metrics)];
  const defs={
    hc:{label:scope.operation?'HC de la operación':'HC requerido',unit:'HC',base:base.hc,sim:simulated.hc},
    units:{label:'Unidades planificadas',unit:'un.',base:base.units,sim:simulated.units},
    efficiency:{label:'Eficiencia aplicada al balance',unit:'%',base:base.efficiency,sim:simulated.efficiency},
    sam:{label:scope.operation?'SAM de la operación':'SAM ponderado',unit:'SAM',base:base.sam,sim:simulated.sam}
  };
  const rows=metrics.map(metric=>{
    const d=defs[metric];
    const delta=(Number(d.sim)||0)-(Number(d.base)||0);
    const pct=(Number(d.base)||0)?delta/(Number(d.base)||0)*100:null;
    return{metric,label:d.label,unit:d.unit,base:Number(d.base)||0,simulated:Number(d.sim)||0,delta,pct};
  });
  return{ok:true,kind:'scenario_compare',scope,change:last,metrics,rows,base,simulated};
}
function applyScenario(baseRows,changes){
  const sim=JSON.parse(JSON.stringify(baseRows));
  for(const c of (changes||[])){
    const scope=c.scope||{};
    if(c.type==='hours'){
      for(const r of scenarioRowsForScope(sim,scope,false)){
        const oldH=Number(r.horas)||1;
        const delta=Number(c.value)||0;
        const newH=c.mode==='add'?oldH+delta:c.mode==='subtract'?oldH-delta:(Number(c.value)||oldH);
        if(newH<=0)continue;
        r.horas=newH;
        for(const o of(r.operaciones||[]))o.hc=(Number(o.hc)||0)*(oldH/newH);
        scenarioRecalcRow(r);
      }
    } else if(c.type==='efficiency'){
      for(const r of scenarioRowsForScope(sim,scope,true)){
        for(const o of(r.operaciones||[])){
          if(scope.operation&&o.operacion!==scope.operation)continue;
          const oldE=(Number(o.eficiencia)>1?Number(o.eficiencia)/100:Number(o.eficiencia))||0.5;
          const delta=Number(c.value)||0;
          const newE=c.mode==='add'?oldE+delta:c.mode==='subtract'?oldE-delta:(Number(c.value)||oldE);
          if(newE<=0)continue;
          o.eficiencia=newE*100;
          o.hc=(Number(o.hc)||0)*(oldE/newE);
        }
        scenarioRecalcRow(r);
      }
    } else if(c.type==='sam'){
      for(const r of scenarioRowsForScope(sim,scope,true)){
        for(const o of(r.operaciones||[])){
          if(scope.operation&&o.operacion!==scope.operation)continue;
          const oldS=Number(o.sam)||0.0001,delta=Number(c.value)||0;
          const newS=c.mode==='add'?oldS+delta:c.mode==='subtract'?oldS-delta:(Number(c.value)||oldS);
          if(newS<=0)continue;
          o.sam=newS;
          o.hc=(Number(o.hc)||0)*(newS/oldS);
        }
        scenarioRecalcRow(r);
      }
    } else if(c.type==='units'){
      const target=scenarioRowsForScope(sim,scope,!!scope.operation);
      const current=scenarioUniqueUnits(target);
      if(current>0){
        const desired=c.mode==='add'?current+Number(c.value):c.mode==='subtract'?Math.max(0,current-Number(c.value)):Number(c.value);
        const factor=desired/current;
        for(const r of target){
          r.unidades=(Number(r.unidades)||0)*factor;
          for(const o of(r.operaciones||[]))o.hc=(Number(o.hc)||0)*factor;
          scenarioRecalcRow(r);
        }
      }
    }
  }
  return sim;
}

return{
  freshState,cloneState,norm,explicitEntities,requestedMetrics,primaryMetric,pairedOrdinalReference,comparisonDiagnostics,
  resolveReferences,resolveOrdinal,ordinalIndex,resolveDescriptiveReference,
  classifyIntent,detectTarget,isScopeRefinementTurn,applyScopeRefinementFrame,buildPlan,validatePlan,reconcilePlanWithIntent,
  ambiguity,updateState,needsModelPlan,modelPlannerPrompt,bindModelPlan,execute,
  scenarioQuantityForType,scenarioResolveSuperlativeScope,parseScenarioChange,scenarioEditIntent,scenarioContinuationMode,scenarioTransaction,applyScenario,scenarioRowsForScope,scenarioSummaryForScope,scenarioComparisonSnapshot,isScenarioComparison
};
});
