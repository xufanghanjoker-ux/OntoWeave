ALTER TABLE product_upload_v1.uploads
    DROP CONSTRAINT uploads_pkey,
    ADD PRIMARY KEY (library_ref,actor_ref,operation_ref);
