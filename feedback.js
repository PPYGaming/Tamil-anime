'use strict';
(function(){
  const button=document.querySelector('.feedback-toggle'),section=document.getElementById('feedback');
  if(!button||!section)return;
  button.addEventListener('click',function(event){
    event.preventDefault();
    const details=section.querySelector('details');if(details)details.open=true;
    section.scrollIntoView({behavior:'smooth',block:'center'});
    const message=document.getElementById('feedbackMessage');if(message)message.focus({preventScroll:true});
  });
})();
