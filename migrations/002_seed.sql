INSERT INTO products(slug,name,short_description,category,status,sort) VALUES
('exile-ai','Exile AI','Personal artificial intelligence.','Artificial Intelligence','in_development',1),
('nexchat','NexChat','Private, local-first communication.','Communication','in_development',2),
('hi-link','Hi-Link','A digital campus and student social ecosystem.','Education','in_development',3),
('exile-os','Exile OS','Independent computing infrastructure and operating-system research.','Operating Systems','research',4),
('infinity','Infinity','Future Exile hardware ecosystem.','Hardware','research',5),
('flowx','Flowx','Experimental productivity and interaction technology.','Human-Computer Interaction','experimental',6),
('nebula','Nebula','Experimental lightweight system/kernel technology.','Operating Systems','experimental',7);
INSERT INTO exile_log_entries(date,title,description,category,status) VALUES('2026','Exile Organization established','Exile Organization begins as the umbrella for its AI, communication, education and systems work.','Organization','done');
INSERT INTO portfolio(id,name,title,intro,bio,github,skills,education) VALUES(1,'Bryanna Manu','Technology Founder','Create technology that improves education, privacy, and digital experiences — starting in Kenya, built for anywhere.','Diploma ICT student (TVET/CDACC) and software builder in Kenya, working across programming, web development and systems analysis. Builds full systems outside class.','','["Structured & OOP Programming","Full-Stack Web Development","Systems Analysis & Architecture","Language Design"]','["TVET/CDACC Diploma ICT (in progress)"]');
INSERT INTO portfolio_projects(title,description,status,sort) VALUES
('UniLink','University social and learning ecosystem for Kenyan students.','In development',1),
('Project Exile','Python cognitive OS with layered memory, planner and knowledge graph.','In development',2),
('Iris Programming Language','Original language designed from scratch to demonstrate language-design understanding.','In development',3);
INSERT INTO site_settings VALUES('tagline','Building technology for a freer digital future.'),('show_public_stats','0'),('contact_email',''),('about','Exile Organization builds products and infrastructure around AI, communication, education, operating systems, privacy and digital infrastructure. Edit this text in the admin panel.'),('careers','No open roles are listed yet. Edit this in the admin panel.');
