import assert from 'node:assert/strict';
// Shared by the isolated site harness. Every record is synthetic.
export async function recruitmentRegressions({lib,recruit,anon,R,ctxFor,admin,plain,journal,now}) {
  const { validateAnswers } = await lib('recruit/fixed-form.js');
  const basic=[{key:'name',type:'short',required:true},{key:'email',type:'email',required:true}];
  const values={name:'Test',email:'test@example.com'};
  for(const key of ['year','subteam']) {
    assert.ok(validateAnswers({questions:[...basic,{key,type:'single',required:true,options:['2027']}]},{answers:values}).error);
    assert.equal(validateAnswers({questions:[...basic,{key,type:'short'}]},{answers:{...values,[key]:'2027'}}).answers[key],'2027');
    assert.deepEqual(validateAnswers({questions:[...basic,{key,type:'multi',options:['One','Two']}]},{answers:{...values,[key]:['One','Two']}}).answers[key],['One','Two']);
  }
  const kit=R.kitFor(ctxFor(admin));
  const settings=async(settings)=>{const c=(await recruit('GET','/recruit/cycles/cy-interest')).data.cycle;const out=await recruit('PUT','/recruit/cycles/cy-interest/settings/site',{version:c.version,settings}); assert.equal(out.status,200,out.text);return out;};
  let c=(await recruit('GET','/recruit/cycles/cy-interest')).data.cycle;
  assert.equal((await recruit('PUT','/recruit/cycles/cy-interest/settings/site',{version:c.version,settings:{sections:{people:{title:'People'}}}})).status,400,'navigation key is reserved');
  await settings({sections:{attachments:{title:'Attachments',open:true,form:{questions:[...basic,{key:'resume',type:'file',required:true},{key:'portfolio',type:'file',required:true}]}},capped:{title:'Capped',open:true,capacity:1,form:{questions:basic}}}});
  const uploads={resume:{name:'resume.pdf',type:'application/pdf',data:'JVBERi0xLjQK'},portfolio:{name:'portfolio.pdf',type:'application/pdf',data:'JVBERi0xLjQK'}};
  const sent=await anon('POST','/recruit/site/attachments',{answers:{name:'Files',email:'files@example.com'},files:uploads});assert.equal(sent.status,200,sent.text);
  const filesPerson=(await recruit('GET','/recruit/cycles/cy-interest/people/files%40example.com')).data;
  const row=filesPerson.submissions[0].application;
  assert.deepEqual(row.files.map(f=>f.question),['resume','portfolio']);
  for(const f of row.files) assert.equal((await recruit('GET',`/recruit/files/${f.id}`)).status,200);
  const duplicate = await anon('POST','/recruit/site/attachments',{answers:{name:'Files again',email:'files@example.com'},files:uploads});
  assert.equal(duplicate.status,409);
  const pending = (await recruit('GET','/recruit/queue')).data.pending.find((p) => p.id === duplicate.data.receipt);
  assert.equal(pending.files.length,2);
  for (const f of pending.files) assert.equal((await recruit('GET',f.url.replace('/api',''))).status,200);
  const multiForm={questions:[...basic,{key:'a',type:'file'},{key:'b',type:'file'}]};
  const huge={name:'x.pdf',type:'application/pdf',data:Buffer.alloc(1500000).toString('base64')};
  assert.equal(validateAnswers(multiForm,{answers:values,files:{a:huge,b:huge}}).status,413,'aggregate upload limit');
  // A second cycle with no interest form proves replay has no interest-only dependency.
  c=(await recruit('GET','/recruit/cycles/cy-interest')).data.cycle;
  kit.mem.cycles.push({...structuredClone(c),id:'cy-replay',doc:{...c.doc,site:{sections:{interest:null,coffee:null,application:null,round:{title:'Round',open:true,form:{questions:multiForm.questions}}}}}});
  const rid=`jr-${now()+100}-abcdef0123456789abcdef01`;
  const bytes=Buffer.from('%PDF-test');
  await journal.append({id:rid,version:2,ts:now()+100,cycleId:'cy-replay',section:'round',name:'Replay',email:'replay@example.com',answers:{note:'Keep this'},files:[{question:'a',name:'a.pdf',type:'application/pdf',size:bytes.length},{question:'b',name:'b.pdf',type:'application/pdf',size:bytes.length}]},[{data:bytes},{data:bytes}],{});
  await kit.intake.replay(ctxFor(admin));
  const recovered=await kit.apps.allByEmail('cy-replay','replay@example.com');
  assert.equal(recovered.length,1); assert.equal(recovered[0].section,'round'); assert.deepEqual(recovered[0].files.map(f=>f.question),['a','b']);
  await kit.intake.replay(ctxFor(admin)); assert.equal((await kit.apps.allByEmail('cy-replay','replay@example.com')).length,1);
  // Capacity is checked atomically and does not consume a slot on replacement.
  const cap=await Promise.all([anon('POST','/recruit/site/capped',{answers:{name:'First',email:'first@example.com'}}),anon('POST','/recruit/site/capped',{answers:{name:'Second',email:'second@example.com'}})]);
  assert.deepEqual(cap.map(r=>r.status).sort(),[200,409]);
  const admitted=(await recruit('GET','/recruit/cycles/cy-interest/applications?section=capped')).data.rows[0];
  assert.equal((await anon('POST','/recruit/site/capped',{answers:{name:'Updated',email:admitted.email},confirmUpdate:true})).status,200);
  assert.equal((await anon('GET','/recruit/site')).data.sections.find(s=>s.key==='capped').available,false);
  assert.equal((await anon('GET','/recruit/site')).data.sections.find(s=>s.key==='capped').full,true);
  const capRow = kit.mem.applications.find(a => a.id === admitted.id);
  capRow.erasedAt = now();
  assert.equal((await anon('GET','/recruit/site')).data.sections.find(s=>s.key==='capped').available,true,'erased responses do not consume capacity');
  capRow.erasedAt = null;
  // Legacy reviews appear in both the person and response lists and the CSV.
  const legacy=kit.mem.applications.find(a=>a.email==='legacy@example.com');
  legacy.review={flagged:true,comments:[{id:'ic-regression-legacy',text:'Keep this',by:admin.email}]};
  const response=(await recruit('GET','/recruit/cycles/cy-interest/applications?section=interest&flagged=1')).data.rows.find(a=>a.email===legacy.email);
  assert.equal(response.flagged,true);assert.equal(response.comments,1);
  const csv=(await recruit('GET','/recruit/cycles/cy-interest/people.csv')).text;
  assert.match(csv.split('\n').find(line=>line.includes(legacy.email)),/"yes","1"/);
  await recruit('PUT','/recruit/cycles/cy-interest/roles/plain%40example.com',{requestId:'rq-regression-reviewer',roles:['reviewer'],subteams:['mechanical']});
  assert.equal((await recruit('GET',`/recruit/cycles/cy-interest/applications/${row.id}`,{},plain)).status,404);
  assert.equal((await recruit('GET',`/recruit/files/${row.files[0].id}`,{},plain)).status,404,'file follows owning response scope');
  await recruit('PUT','/recruit/cycles/cy-interest/roles/plain%40example.com',{requestId:'rq-regression-lead',roles:['lead']});
  assert.equal((await recruit('GET','/recruit/applicants/replay%40example.com',{},plain)).status,404,'a lead in another cycle cannot read this applicant');
  await settings({sections:{empty:{title:'Empty',open:true}},landing:'empty'});
  const removed=await settings({remove:['empty']});assert.equal(removed.data.cycle.doc.site.landing,null);
  // More than the former 2,000-person limit; a late search and export remain complete.
  const template=kit.mem.applications[0];
  for(let i=0;i<2010;i++) kit.mem.applications.push({...structuredClone(template),id:'in-many-'+i,cycleId:'cy-replay',email:`many${i}@example.com`,name:'Many '+i,section:'round',ts:i+1,updated:i+1,review:{},files:[]});
  const page=(await recruit('GET','/recruit/cycles/cy-replay/people?limit=100')).data;
  assert.equal(page.total,2011);assert.equal(page.rows.length,100);assert.ok(page.next);
  const nextPage=(await recruit('GET','/recruit/cycles/cy-replay/people?limit=100&cursor='+page.next)).data;
  assert.equal(nextPage.rows.length,100); assert.ok(!nextPage.rows.some(p=>page.rows.some(old=>old.email===p.email)), 'people pages never overlap');
  const found=(await recruit('GET','/recruit/cycles/cy-replay/people?q=many2009%40')).data;assert.equal(found.total,1);
  const complete=(await recruit('GET','/recruit/cycles/cy-replay/people.csv')).text;assert.equal(complete.split('\r\n').length,2012);
  console.log('PASS: regressions — dynamic types, two-file receipt/replay, capacity, scoped files/applicants, shared review summaries/CSV, landing removal, 2,011-person pagination/search/export');
}
