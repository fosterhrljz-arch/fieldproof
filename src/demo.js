(() => {
  const {empty, asDate, localDay, shift, makeInspection, addWork, perform} = FP;
  FP.demo = (today = localDay()) => {
    const state = empty();
    state.workspace = 'Harborstone Facilities';
    state.people.push(
      {id:'jordan', name:'Jordan Carter', role:'Inspector'},
      {id:'maya', name:'Maya Rivera', role:'Maintenance'},
      {id:'sam', name:'Sam Patel', role:'Maintenance'},
      {id:'lin', name:'Lin Chen', role:'Inspector'}
    );
    state.settings.defaultAssignee = 'maya';
    const place = (id, name, kind, parentId = '', notes = '') => ({id,name,kind,parentId,notes});
    state.places = [
      place('harbor','Harborstone Commons','Site','','120 Harborview Avenue'),
      place('harbor-a','Building A','Building','harbor'),
      place('harbor-mech','Mechanical Room','Area','harbor-a','Basement level, east service corridor'),
      place('harbor-roof','Roof','Area','harbor-a'),
      place('harbor-lobby','Main Lobby','Area','harbor-a'),
      place('harbor-b','Building B','Building','harbor'),
      place('harbor-elec','Electrical Room','Area','harbor-b'),
      place('riverside','Riverside Business Park','Site','','499 Riverside Drive'),
      place('riverside-west','West Wing','Building','riverside'),
      place('riverside-yard','Service Yard','Area','riverside-west'),
      place('riverside-level','Level 2','Area','riverside-west'),
      place('riverside-loading','Loading Bay','Area','riverside-west')
    ];
    const now = asDate(today).toISOString();
    const asset = (id,name,tag,type,areaId,manufacturer,model,serial,status='In service',notes='') =>
      ({id,name,tag,type,areaId,manufacturer,model,serial,status,notes,updatedAt:now,changes:[]});
    state.assets = [
      asset('pump','Domestic Water Pump P-01','PMP-001','Water pump','harbor-mech','Grundfos','NB 65-160','GRF-448731','In service','Lead domestic water circulation pump. Standby pump P-02 is on the same skid.'),
      asset('rtu','Rooftop Unit RTU-04','RTU-004','Rooftop unit','harbor-roof','Trane','Precedent','TRN-709126'),
      asset('lobby','Lobby Fire Door FD-01','DOR-001','Fire door','harbor-lobby','Allegion','LCN 4040XP','LCN-480012'),
      asset('panel','Distribution Panel DP-02','ELE-002','Electrical panel','harbor-elec','Eaton','Pow-R-Line','ETN-302745'),
      asset('gen','Standby Generator G-01','GEN-001','Generator','riverside-yard','Cummins','C60 D6','CUM-412232'),
      asset('ahu','Air Handler AHU-07','AHU-007','Air handler','riverside-level','Carrier','39M','CAR-233191'),
      asset('door','Loading Bay Door LD-03','DOR-003','Sectional door','riverside-loading','Overhead Door','Thermacore','ODC-874218'),
      asset('pump2','Standby Water Pump P-02','PMP-002','Water pump','harbor-mech','Grundfos','NB 65-160','GRF-448732')
    ];
    const q = (id,label,criteria,priority='Medium') => ({id,label,criteria,priority});
    const template = (id,name,description,questions) => ({id,name,description,questions,archived:false});
    state.templates = [
      template('water','Water pump inspection','Routine checks for domestic circulation pumps.',[
        q('seal','Check pump seal for leaks','Seal, flange, and floor beneath the pump are dry.','High'),
        q('noise','Listen for abnormal vibration or noise','Pump runs steadily without rattling, grinding, or unusual movement.'),
        q('pressure','Check discharge pressure','Gauge reading is between 45 and 65 psi during normal operation.','High')
      ]),
      template('hvac','HVAC equipment inspection','Routine operational checks for rooftop units and air handlers.',[
        q('filter','Inspect filters and filter housing','Filters are seated, clean, and free of bypass gaps.'),
        q('drain','Inspect condensate drainage','Pan is clear and drain line flows without standing water.','High'),
        q('control','Check safety switch and controls','Safety switch and thermostat respond as expected.','High')
      ]),
      template('door-check','Door and access inspection','Functional checks for doors and associated hardware.',[
        q('latch','Confirm latch and closer operation','Door closes and latches without binding.','High'),
        q('hardware','Inspect hinges and hardware','Fasteners are secure and hardware is free of cracks or excessive wear.')
      ]),
      template('electrical','Electrical room walk-through','External condition checks for panels and standby equipment.',[
        q('clear','Verify access clearance','Approach is unobstructed and equipment labels are legible.'),
        q('visual','Check for damage and alarms','No visible damage, warning indicators, or unusual odor.','High')
      ])
    ];
    const pairs = [['water','pump'],['hvac','rtu'],['door-check','lobby'],['electrical','panel'],['electrical','gen'],['hvac','ahu'],['door-check','door'],['water','pump2']];
    const at = (offset, hour = 10, minute = 0) => {
      const date = asDate(shift(today,offset));
      date.setHours(hour,minute);
      return date.toISOString();
    };
    const inspect = (offset, index, draft = false) => {
      const [templateId,assetId] = pairs[index % pairs.length];
      const assigneeId = index % 3 ? 'lin' : 'jordan';
      const record = makeInspection(state,{templateId,assetId,assigneeId,due:shift(today,offset)},at(offset - 3));
      if (draft) perform(state,{type:'startInspection',id:record.id,actorId:assigneeId},at(Math.min(0,offset),9));
      return record;
    };
    for (let index = 0; index < 20; index++) {
      const offset = index < 10 ? -58 + index * 3 : -29 + (index - 10) * 3;
      const record = inspect(offset,index + 1);
      record.questions.forEach((question, order) => {
        const failed = index % 4 === 0 && order === 0;
        perform(state,{type:'result',id:record.id,questionId:question.id,actorId:record.assigneeId,fields:{value:failed ? 'Fail':'Pass',
          notes:failed ? 'Condition outside the checklist criteria. Maintenance follow-up required.' : ''}},at(offset,9,order));
      });
      const ids = perform(state,{type:'submit',id:record.id,actorId:record.assigneeId},at(offset,9,10));
      ids.forEach(id => {
        if (index < 18) complete(id,offset,offset+1);
      });
    }
    function complete(id, started, ended) {
      perform(state,{type:'startWork',id,actorId:'maya'},at(started,11));
      perform(state,{type:'repairDraft',id,actorId:'maya',fields:{notes:'Corrected the reported condition and repeated the operating check.'}},at(ended,9));
      perform(state,{type:'requestReview',id,actorId:'maya'},at(ended,9,15));
      perform(state,{type:'close',id,actorId:'morgan',fields:{notes:'Verified normal operation on site.'}},at(ended,13));
    }
    const issue = (title, assetId, due, created, priority, assigneeId = 'maya', description = '') =>
      addWork(state,{title,assetId,due:shift(today,due),assigneeId,priority,description},at(created),state.people[0]);
    const historical = [
      ['Clear condensate drain','ahu',-57,-62],['Adjust loading bay door travel','door',-51,-55],['Secure panel label holder','panel',-46,-50],
      ['Replace generator battery terminal','gen',-38,-46],['Clean rooftop unit drain pan','rtu',-34,-40],['Replace lobby door closer','lobby',-25,-31],
      ['Replace return air filter','ahu',-23,-25],['Recalibrate discharge gauge','pump',-17,-20],['Secure generator access latch','gen',-13,-16],
      ['Service door track rollers','door',-10,-12],['Clean intake screen','rtu',-7,-10],['Relabel distribution circuits','panel',-2,-5]
    ];
    historical.forEach(([title,id,end,start]) => complete(issue(title,id,end,start,'Medium').id,start,end));
    const leak = inspect(0,0,true);
    perform(state,{type:'result',id:leak.id,questionId:'seal',actorId:'jordan',fields:{value:'Fail',
      notes:'Water is collecting below the shaft seal while the pump is running. Leak is localized at the flange.'}},at(0,9,12));
    inspect(-3,2);
    inspect(-6,5);
    inspect(-1,4);
    inspect(5,7);
    inspect(8,1);
    [
      ['Reset rooftop unit safety switch','rtu',-5,-14,'High','sam','Rooftop unit stopped on a safety switch trip. Check condensate level and confirm stable operation.'],
      ['Adjust fire door closer tension','lobby',-3,-10,'High','maya','Door does not latch freely after release from 90 degrees.'],
      ['Clear storage from panel access','panel',-1,-9,'Urgent','sam','Remove stored cartons from the electrical equipment access zone.'],
      ['Inspect standby pump coupling','pump2',-1,-5,'Medium','maya','Slight irregular movement noted during the previous run test.'],
      ['Replace worn bay door guide roller','door',1,-12,'Medium','sam','Roller intermittently jams during a full opening cycle.'],
      ['Replace air handler filter bank','ahu',3,-7,'Medium','maya','Install the specified replacement filters and check seating.'],
      ['Verify generator battery charger','gen',2,-3,'High','sam','Charger fault indicator was observed on the last walk-through.'],
      ['Secure pump isolation valve handle','pump',4,-3,'Low','maya','Handle is loose on the isolation valve stem.'],
      ['Check thermostat calibration','rtu',6,-2,'Low','maya','Compare the thermostat reading with an independent sensor.'],
      ['Replace service yard light guard','gen',8,-2,'Low','sam','Guard mounting clips are damaged.'],
      ['Reseat inspection panel gasket','ahu',9,-1,'Medium','maya','Air bypass is audible along the left access panel.'],
      ['Adjust door sweep clearance','door',10,-1,'Low','sam','Sweep rubs the slab at the lowest point.']
    ].forEach(([title,id,due,created,priority,owner,description],index) => {
      const order = issue(title,id,due,created,priority,owner,description);
      if ([4,5,6,10,11].includes(index)) perform(state,{type:'startWork',id:order.id,actorId:owner},at(created,13));
      if ([10,11].includes(index)) {
        perform(state,{type:'repairDraft',id:order.id,actorId:owner,fields:{notes:'Adjusted the assembly and confirmed normal operation. Ready for an independent field check.'}},at(created,14));
        perform(state,{type:'requestReview',id:order.id,actorId:owner},at(created,15));
      }
    });
    state.schedules.push({id:'standby-weekly',templateId:'water',assetId:'pump2',assigneeId:'jordan',start:shift(today,5),interval:'Every two weeks',paused:false,index:1});
    state.inspections.find(item => item.assetId === 'pump2' && item.due === shift(today,5)).scheduleId = 'standby-weekly';
    return {state, photoTarget:{inspectionId:leak.id,questionId:'seal'}};
  };
})();
