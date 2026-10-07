'use strict';
(function(){
  const image=document.getElementById('feedbackImage');
  if(image)image.addEventListener('change',function(){
    const file=image.files&&image.files[0];
    const validTypes=['image/png','image/jpeg','image/webp','image/gif'];
    image.setCustomValidity(!file?'':!validTypes.includes(file.type)?'Choose a PNG, JPEG, WebP or GIF image.':file.size>10*1024*1024?'Choose an image smaller than 10MB.':'');
    image.reportValidity();
  });
  const button=document.querySelector('.feedback-toggle'),section=document.getElementById('feedback');
  if(!button||!section)return;
  button.addEventListener('click',function(event){
    event.preventDefault();
    const details=section.querySelector('details');if(details)details.open=true;
    section.scrollIntoView({behavior:'smooth',block:'center'});
    const message=document.getElementById('feedbackMessage');if(message)message.focus({preventScroll:true});
  });
})();
